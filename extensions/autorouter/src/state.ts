import { Model, Api } from "@mariozechner/pi-ai";
import { ThinkingLevel } from "./types";

export class AutorouterState {
  config: any = null;
  enabled = true;
  
  savedModel: Model<Api> | undefined;
  savedThinking: ThinkingLevel | undefined;
  
  activeRoute: string | null = null;
  activeModelId: string | null = null;
  
  tokenRoute: string | null = null;
  
  stickyRoute: string | null = null;
  stickyModel: Model<Api> | undefined;
  stickyThinking: ThinkingLevel | undefined;
  stickyRemaining = 0;

  resetSticky() {
    this.stickyRemaining = 0;
    this.stickyRoute = null;
    this.stickyModel = undefined;
    this.stickyThinking = undefined;
  }
}
