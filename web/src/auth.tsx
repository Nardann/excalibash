import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type User } from "./api.ts";
import { forgetKeys, loadKeys } from "./account.ts";
import type { KeyPair } from "./crypto.ts";

type AuthState = {
  /** undefined while loading, null when signed out. */
  user: User | null | undefined;
  /** null when signed in but this device has not unlocked the account yet. */
  keys: KeyPair | null;
  signedIn: (user: User, keys: KeyPair) => void;
  setKeys: (keys: KeyPair) => void;
  setUser: (u: User) => void;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState>(null as unknown as AuthState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [keys, setKeys] = useState<KeyPair | null>(null);

  useEffect(() => {
    api
      .get<{ user: User }>("/auth/me")
      .then(async (r) => {
        setKeys(await loadKeys(r.user.id));
        setUser(r.user);
      })
      .catch(() => setUser(null));
  }, []);

  const signedIn = useCallback((u: User, k: KeyPair) => {
    setKeys(k);
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    await api.post("/auth/logout").catch(() => {});
    await forgetKeys();
    setKeys(null);
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, keys, signedIn, setKeys, setUser, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

/** The signed-in, unlocked user; only call below the auth guard. */
export const useUser = () => useContext(AuthContext).user!;
export const useKeys = () => useContext(AuthContext).keys!;
