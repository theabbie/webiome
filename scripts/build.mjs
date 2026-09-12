import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await mkdir("docs", { recursive: true });

let app = await readFile("src/app.js", "utf8");
app = app
  .replace(
    `import { Agent } from "@earendil-works/pi-agent-core";`,
    `import { Agent } from "https://esm.sh/@earendil-works/pi-agent-core@0.85.1?bundle";`,
  )
  .replace(
    `import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";`,
    `import { createAssistantMessageEventStream, Type } from "https://esm.sh/@earendil-works/pi-ai@0.85.1?bundle";`,
  );

let html = await readFile("src/index.html", "utf8");
html = html.replace("%%WEBIOME_BUNDLE%%", app);
await writeFile("dist/index.html", html);
await writeFile("docs/index.html", html);
await cp("assets", "dist/assets", { recursive: true });
await cp("assets", "docs/assets", { recursive: true });

let worker = await readFile("src/worker.template.js", "utf8");
await writeFile("src/worker.js", worker);
