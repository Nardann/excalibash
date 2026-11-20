// Proof of work (ALTCHA style): find n such that sha256(salt + n) == challenge. Works in browsers and Node.
export type Challenge = { salt: string; challenge: string; maxnumber: number; expires: number; signature: string };
export type PowSolution = { salt: string; number: number; challenge: string; expires: number; signature: string };

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

export async function solveChallenge(c: Challenge): Promise<PowSolution> {
  const enc = new TextEncoder();
  for (let n = 0; n <= c.maxnumber; n++) {
    if (hex(await crypto.subtle.digest("SHA-256", enc.encode(c.salt + n))) === c.challenge) {
      return { salt: c.salt, number: n, challenge: c.challenge, expires: c.expires, signature: c.signature };
    }
    if (n % 2000 === 1999) await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("Vérification anti-robot impossible, réessaie");
}
