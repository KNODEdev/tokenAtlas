/**
 * The `entrypoint` the native parser writes on rows read from archived Claude cloud sessions
 * (native/tokenatlas-parse/src/claude_cloud.rs). Their call rows carry no output: each turn's output is
 * in its own `turn:` row. A transcript copy of the same call (a teleported session) must therefore never
 * win over the cloud row by having more output; the cloud row is kept whole, place included.
 */
export const CLAUDE_CLOUD_ENTRYPOINT = "cloud";
