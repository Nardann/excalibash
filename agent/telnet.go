package main

import (
	"net"
	"sync"
)

// Telnet client (RFC 854) with just enough option negotiation for network equipment and
// Unix hosts: the server may echo and suppress go-ahead, we report the window size (NAWS)
// and terminal type (TTYPE); every other option is refused.

const (
	tnSE   = 240
	tnSB   = 250
	tnWILL = 251
	tnWONT = 252
	tnDO   = 253
	tnDONT = 254
	tnIAC  = 255

	optEcho  = 1
	optSGA   = 3
	optTType = 24
	optNAWS  = 31

	ttypeIS   = 0
	ttypeSend = 1
	termType  = "XTERM-256COLOR"
	maxSB     = 256
)

const (
	tsData = iota
	tsCR
	tsIAC
	tsVerb
	tsSB
	tsSBIAC
)

type telnet struct {
	conn net.Conn

	// mu guards the option state and serialises writes to conn.
	mu       sync.Mutex
	remoteOn map[byte]bool // options the server performs (ECHO, SGA)
	localOn  map[byte]bool // options we perform (NAWS, TTYPE)
	offered  map[byte]bool // WILL sent by us, not yet answered
	cols     uint16
	rows     uint16

	// parser state, used by the reading goroutine only
	state int
	verb  byte
	sb    []byte
}

func newTelnet(conn net.Conn, cols, rows uint16) *telnet {
	return &telnet{
		conn: conn, cols: cols, rows: rows,
		remoteOn: map[byte]bool{}, localOn: map[byte]bool{}, offered: map[byte]bool{},
	}
}

func (r *remote) runTelnet() int {
	conn, ok := r.dial()
	if !ok {
		return 1
	}
	defer conn.Close()
	tn := newTelnet(conn, 80, 24)
	r.setResize(tn.resize)
	tn.resize(r.size()) // NAWS is not on yet: this only records the size
	tn.start()
	go r.pumpInput(tn)

	buf := make([]byte, readChunk)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			if data := tn.parse(buf[:n]); len(data) > 0 {
				if _, werr := r.outW.Write(data); werr != nil {
					return 0
				}
			}
		}
		if err != nil {
			break
		}
	}
	r.closedBy()
	return 0
}

// start offers NAWS so that the server learns the window size without asking.
func (tn *telnet) start() {
	tn.mu.Lock()
	defer tn.mu.Unlock()
	tn.offered[optNAWS] = true
	tn.send(tnIAC, tnWILL, optNAWS)
}

// send writes raw protocol bytes. Caller holds tn.mu.
func (tn *telnet) send(b ...byte) {
	_, _ = tn.conn.Write(b)
}

// Write sends keystrokes: 0xFF is doubled and a bare CR becomes CR LF (NVT newline).
func (tn *telnet) Write(p []byte) (int, error) {
	out := make([]byte, 0, len(p)+8)
	for i, c := range p {
		switch {
		case c == tnIAC:
			out = append(out, tnIAC, tnIAC)
		case c == '\r' && (i+1 == len(p) || (p[i+1] != '\n' && p[i+1] != 0)):
			out = append(out, '\r', '\n')
		default:
			out = append(out, c)
		}
	}
	tn.mu.Lock()
	defer tn.mu.Unlock()
	if _, err := tn.conn.Write(out); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (tn *telnet) resize(cols, rows uint16) {
	tn.mu.Lock()
	defer tn.mu.Unlock()
	tn.cols, tn.rows = cols, rows
	if tn.localOn[optNAWS] {
		tn.sendNAWS()
	}
}

// sendNAWS reports the window size. Caller holds tn.mu.
func (tn *telnet) sendNAWS() {
	msg := []byte{tnIAC, tnSB, optNAWS}
	for _, b := range []byte{byte(tn.cols >> 8), byte(tn.cols), byte(tn.rows >> 8), byte(tn.rows)} {
		msg = append(msg, b)
		if b == tnIAC {
			msg = append(msg, tnIAC)
		}
	}
	tn.send(append(msg, tnIAC, tnSE)...)
}

// parse strips protocol commands from what the server sent and returns the data to display.
func (tn *telnet) parse(in []byte) []byte {
	out := make([]byte, 0, len(in))
	for _, c := range in {
		switch tn.state {
		case tsCR:
			tn.state = tsData
			if c == 0 { // CR NUL is a bare carriage return
				continue
			}
			fallthrough
		case tsData:
			switch c {
			case tnIAC:
				tn.state = tsIAC
			case '\r':
				out = append(out, c)
				tn.state = tsCR
			default:
				out = append(out, c)
			}
		case tsIAC:
			switch c {
			case tnIAC:
				out = append(out, c)
				tn.state = tsData
			case tnWILL, tnWONT, tnDO, tnDONT:
				tn.verb, tn.state = c, tsVerb
			case tnSB:
				tn.sb, tn.state = tn.sb[:0], tsSB
			default: // NOP, GA, AYT…
				tn.state = tsData
			}
		case tsVerb:
			tn.negotiate(tn.verb, c)
			tn.state = tsData
		case tsSB:
			if c == tnIAC {
				tn.state = tsSBIAC
			} else if len(tn.sb) < maxSB {
				tn.sb = append(tn.sb, c)
			}
		case tsSBIAC:
			switch c {
			case tnSE:
				tn.subnegotiate(tn.sb)
				tn.state = tsData
			case tnIAC:
				if len(tn.sb) < maxSB {
					tn.sb = append(tn.sb, c)
				}
				tn.state = tsSB
			default:
				tn.state = tsData
			}
		}
	}
	return out
}

// negotiate answers one option command; requests for a state already in place are ignored,
// which prevents negotiation loops.
func (tn *telnet) negotiate(verb, opt byte) {
	tn.mu.Lock()
	defer tn.mu.Unlock()
	switch verb {
	case tnWILL:
		if opt != optEcho && opt != optSGA {
			tn.send(tnIAC, tnDONT, opt)
		} else if !tn.remoteOn[opt] {
			tn.remoteOn[opt] = true
			tn.send(tnIAC, tnDO, opt)
		}
	case tnWONT:
		if tn.remoteOn[opt] {
			tn.remoteOn[opt] = false
			tn.send(tnIAC, tnDONT, opt)
		}
	case tnDO:
		if opt != optNAWS && opt != optTType {
			tn.send(tnIAC, tnWONT, opt)
			return
		}
		if tn.localOn[opt] {
			return
		}
		if !tn.offered[opt] {
			tn.send(tnIAC, tnWILL, opt)
		}
		tn.localOn[opt], tn.offered[opt] = true, false
		if opt == optNAWS {
			tn.sendNAWS()
		}
	case tnDONT:
		if tn.localOn[opt] {
			tn.send(tnIAC, tnWONT, opt)
		}
		tn.localOn[opt], tn.offered[opt] = false, false
	}
}

func (tn *telnet) subnegotiate(sb []byte) {
	if len(sb) == 2 && sb[0] == optTType && sb[1] == ttypeSend {
		tn.mu.Lock()
		defer tn.mu.Unlock()
		if tn.localOn[optTType] {
			msg := append([]byte{tnIAC, tnSB, optTType, ttypeIS}, termType...)
			tn.send(append(msg, tnIAC, tnSE)...)
		}
	}
}
