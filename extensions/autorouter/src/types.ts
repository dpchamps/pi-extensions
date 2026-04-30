export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface RouteConfig {
  provider: string;
  model: string;
  thinking?: ThinkingLevel;
}

export interface AutorouterConfig {
  enabled?: boolean;
  stickyTurns?: number;
  classifier: {
    provider: string;
    model: string;
    categories: Record<string, string>;
    fallback: string;
    prompt?: string;
    guidance?: string;
  };
  routes: Record<string, RouteConfig>;
  defaultModel: RouteConfig;
}
