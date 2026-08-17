import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRunInfraProvider } from "./provider.js";

/**
 * RunInfer provider extension.
 *
 * Registers a dynamic provider whose model catalog is pulled live from
 * `https://api.runinfra.ai/v1/models`. Users authenticate with
 * `/login runinfra` (prompts for a workspace API key); after login, pi
 * refreshes the catalog and the models become available in `/model`.
 */
export default function runInfraExtension(pi: ExtensionAPI) {
  pi.registerProvider(createRunInfraProvider());
}
