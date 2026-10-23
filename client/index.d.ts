export interface MountOptions {
  /** The port `taglio watch` listens on. `taglio init` writes the project's own. */
  port?: number
  /** The server's full address, in place of http://localhost:<port>. */
  server?: string
}

/** Puts the taglio pencil on the page. Does nothing outside a browser. */
export function mount(options?: MountOptions): void
