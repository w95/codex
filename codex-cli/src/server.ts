import Docker from "dockerode";
import { EventEmitter } from "events";
import express from "express";

interface ContainerInfo {
  container: Docker.Container;
  logs: EventEmitter;
  workDir: string;
}

const docker = new Docker();
const containers: Record<string, ContainerInfo> = {};

const app = express();
app.use(express.json({ limit: "10mb" }));

app.post("/projects", async (req, res) => {
  try {
    const workDir: string = req.body.workDir || "/workspace";
    const container = await docker.createContainer({
      Image: "codex",
      Cmd: ["sleep", "infinity"],
      Tty: true,
      HostConfig: { Binds: [`${workDir}:${workDir}`] },
    });
    await container.start();
    const id = container.id.substring(0, 12);
    containers[id] = { container, logs: new EventEmitter(), workDir };
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/projects/:id/command", async (req, res) => {
  const info = containers[req.params.id];
  if (!info) {
    return res.status(404).send("not found");
  }
  const args: Array<string> = req.body.args || [];
  try {
    const exec = await info.container.exec({
      Cmd: ["codex", "--full-auto", ...args],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: info.workDir,
    });
    const stream = await exec.start({ hijack: true });
    stream.on("data", (c: Buffer) => info.logs.emit("log", c.toString()));
    stream.on("end", () => info.logs.emit("log", "[command finished]\n"));
    res.json({ started: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/projects/:id/logs", (req, res) => {
  const info = containers[req.params.id];
  if (!info) {
    return res.status(404).end();
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (msg: string) => {
    res.write(`data: ${msg.replace(/\n/g, "\ndata: ")}\n\n`);
  };
  info.logs.on("log", send);
  req.on("close", () => {
    info.logs.off("log", send);
  });
});

app.post("/projects/:id/files", async (req, res) => {
  const info = containers[req.params.id];
  if (!info) {
    return res.status(404).send("not found");
  }
  const { path, content } = req.body as { path: string; content: string };
  try {
    const exec = await info.container.exec({
      Cmd: ["bash", "-c", `cat > ${path}`],
      AttachStdin: true,
    });
    const stream = await exec.start({ hijack: true, stdin: true });
    stream.end(content);
    await new Promise((r) => stream.on("end", r));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/projects/:id/files", async (req, res) => {
  const info = containers[req.params.id];
  const filePath = req.query.path as string;
  if (!info || !filePath) {
    return res.status(404).send("not found");
  }
  try {
    const exec = await info.container.exec({
      Cmd: ["cat", filePath],
      AttachStdout: true,
    });
    const stream = await exec.start({ hijack: true });
    let out = "";
    stream.on("data", (c: Buffer) => (out += c.toString()));
    await new Promise((r) => stream.on("end", r));
    res.type("text/plain").send(out);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Codex server listening on ${PORT}`);
});
