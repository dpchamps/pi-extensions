/** Passive process-lifetime task registry, with historical nodes for lineage. */
import type { TaskStatus } from "./completion.js";
import type { BackgroundClient } from "./runner.js";

export interface BackgroundTask {
  id: string;
  client: BackgroundClient;
  sessionFile: string;
  parentSessionFile: string;
  sourceEntryId: string;
  cwd: string;
  firstPrompt: string;
  startedAt: Date;
  killed: boolean;
  isStreaming: boolean;
  error?: string;
}

export interface TaskTreeNode {
  task: BackgroundTask;
  /** A resumed ancestor, included only to give its tracked descendants context. */
  archived: boolean;
  children: TaskTreeNode[];
}

export class BackgroundStore {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly history = new Map<string, BackgroundTask>();
  private nextId = 1;

  allocId(): string {
    return `bg-${this.nextId++}`;
  }
  register(task: BackgroundTask): void {
    this.tasks.set(task.id, task);
  }
  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }
  all(): BackgroundTask[] {
    return [...this.tasks.values()];
  }
  remove(id: string): boolean {
    return this.tasks.delete(id);
  }

  archive(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.history.set(task.sessionFile, task);
    this.tasks.delete(id);
  }

  wasDetached(sessionFile: string, entryId: string): boolean {
    return [...this.tasks.values(), ...this.history.values()].some(
      (task) =>
        task.parentSessionFile === sessionFile &&
        task.sourceEntryId === entryId,
    );
  }

  statusOf(task: BackgroundTask): TaskStatus {
    if (task.killed || !task.client.isAlive()) return "killed";
    return task.isStreaming ? "active" : "paused";
  }

  tree(filter?: (task: BackgroundTask) => boolean): TaskTreeNode[] {
    const selected = this.all().filter(filter ?? (() => true));
    const bySession = new Map([
      ...this.history,
      ...this.all().map((task) => [task.sessionFile, task] as const),
    ]);
    const nodes = new Map<string, TaskTreeNode>();
    const add = (task: BackgroundTask, seen = new Set<string>()): void => {
      if (seen.has(task.id) || nodes.has(task.id)) return;
      seen.add(task.id);
      nodes.set(task.id, {
        task,
        archived: !this.tasks.has(task.id),
        children: [],
      });
      const parent = bySession.get(task.parentSessionFile);
      if (parent) add(parent, seen);
    };
    for (const task of selected) add(task);
    const roots: TaskTreeNode[] = [];
    for (const node of nodes.values()) {
      const parent = bySession.get(node.task.parentSessionFile);
      const parentNode = parent && nodes.get(parent.id);
      // Session forks are acyclic; be defensive about malformed injected data.
      const ancestors = new Set([node.task.sessionFile]);
      let cursor = parent;
      let cycle = false;
      while (cursor) {
        if (ancestors.has(cursor.sessionFile)) {
          cycle = true;
          break;
        }
        ancestors.add(cursor.sessionFile);
        cursor = bySession.get(cursor.parentSessionFile);
      }
      if (parentNode && !cycle) parentNode.children.push(node);
      else roots.push(node);
    }
    const sort = (items: TaskTreeNode[]) => {
      items.sort(
        (a, b) => a.task.startedAt.getTime() - b.task.startedAt.getTime(),
      );
      for (const node of items) sort(node.children);
    };
    sort(roots);
    return roots;
  }
}
