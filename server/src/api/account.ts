import { Router } from "express";
import { requireUser } from "../auth.ts";

/** The signed-in user's own account: onboarding state, self-service deletion. */
export const accountApi = Router();
accountApi.use(requireUser);
