import xtmuxTools, { XtmuxCliError } from "../../extensions/pi-xtmux-tools.ts";

const [name, input = "{}"] = process.argv.slice(2);
if (!name) process.exit(2);
const tools: any[] = [];
const pi = {
  registerTool(tool: unknown) { tools.push(tool); },
  async exec(command: string, args: string[], options?: { signal?: AbortSignal }) {
    const child = Bun.spawn([command, ...args], { env: process.env, stdout: "pipe", stderr: "pipe", ...(options?.signal ? { signal: options.signal } : {}) });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code, killed: child.killed };
  },
};
xtmuxTools(pi as any);
const tool = tools.find((candidate) => candidate.name === name);
if (!tool) process.exit(2);
try {
  const result = await tool.execute("smoke", JSON.parse(input), undefined, undefined, {});
  process.stdout.write(result.content[0].text + "\n");
} catch (error) {
  if (error instanceof XtmuxCliError) {
    process.stderr.write(JSON.stringify(error.payload) + "\n");
    process.exit(error.exitCode);
  }
  throw error;
}
