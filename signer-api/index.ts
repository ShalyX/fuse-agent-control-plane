import type { Request, Response } from "express";
import { createSignerRuntimeApp } from "../src/signer/runtime.js";

const app = createSignerRuntimeApp();

export default async function handler(request: Request, response: Response): Promise<void> {
  (await app)(request, response);
}
