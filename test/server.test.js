const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { after, before, test } = require("node:test");
const path = require("node:path");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const app = require("../server");

let server;
let baseUrl;
const originalToken = process.env.REPLICATE_API_TOKEN;
const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

before(async () => {
  delete process.env.REPLICATE_API_TOKEN;
  delete process.env.OPENROUTER_API_KEY;
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (originalToken === undefined) {
    delete process.env.REPLICATE_API_TOKEN;
  } else {
    process.env.REPLICATE_API_TOKEN = originalToken;
  }
  if (originalOpenRouterKey === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("serves the homepage and only the explicitly allowed local assets", async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const homepage = await page.text();
  assert.match(homepage, /一键去除图片背景/);
  assert.match(homepage, /文字生成图像/);

  const avatar = await fetch(`${baseUrl}/avatar`);
  assert.equal(avatar.status, 200);
  assert.equal(avatar.headers.get("content-type"), "image/jpeg");

  for (const file of ["/server.js", "/package.json", "/.gitignore"]) {
    const response = await fetch(`${baseUrl}${file}`);
    assert.equal(response.status, 404, `${file} should not be publicly served`);
  }
});

test("requires an OpenRouter API key before generating images", async () => {
  const response = await fetch(`${baseUrl}/api/generate-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "一只坐在窗边的猫", aspectRatio: "1:1", quality: "auto" })
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /OPENROUTER_API_KEY/);
});

test("validates image prompts and generation options", async () => {
  const invalidRequests = [
    { prompt: "  ", aspectRatio: "1:1", quality: "auto" },
    { prompt: "a".repeat(2001), aspectRatio: "1:1", quality: "auto" },
    { prompt: "a cat", aspectRatio: "invalid", quality: "auto" },
    { prompt: "a cat", aspectRatio: "1:1", quality: "ultra" }
  ];

  for (const body of invalidRequests) {
    const response = await fetch(`${baseUrl}/api/generate-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
  }
});

test("uses the OpenRouter image API and returns its validated image bytes", async () => {
  const appState = app.locals;
  const originalFetch = appState.openRouterFetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jx2sAAAAASUVORK5CYII=";
  let requestUrl;
  let requestBody;
  let authorization;
  process.env.OPENROUTER_API_KEY = "unit-test-openrouter-key";
  appState.openRouterFetch = async (url, options) => {
    requestUrl = String(url);
    requestBody = JSON.parse(options.body);
    authorization = options.headers.Authorization;
    return new Response(JSON.stringify({
      data: [{ b64_json: imageBase64, media_type: "image/png" }],
      usage: { cost: 0.01234 }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const response = await fetch(`${baseUrl}/api/generate-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "一只坐在窗边的猫",
        aspectRatio: "16:9",
        quality: "high"
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-generation-cost"), "0.0123");
    assert.equal(
      Buffer.from(await response.arrayBuffer()).toString("base64"),
      imageBase64
    );
    assert.equal(requestUrl, "https://openrouter.ai/api/v1/images");
    assert.equal(authorization, "Bearer unit-test-openrouter-key");
    assert.deepEqual(requestBody, {
      model: "openai/gpt-5.4-image-2",
      prompt: "一只坐在窗边的猫",
      n: 1,
      aspect_ratio: "16:9",
      quality: "high"
    });
  } finally {
    appState.openRouterFetch = originalFetch;
    if (previousKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousKey;
    }
  }
});

test("returns a clear message when OpenRouter has insufficient credit", async () => {
  const appState = app.locals;
  const originalFetch = appState.openRouterFetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "unit-test-openrouter-key";
  appState.openRouterFetch = async () => new Response(
    JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }),
    { status: 402, headers: { "Content-Type": "application/json" } }
  );

  try {
    const response = await fetch(`${baseUrl}/api/generate-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", aspectRatio: "1:1", quality: "auto" })
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /OpenRouter 账户余额不足/);
  } finally {
    appState.openRouterFetch = originalFetch;
    if (previousKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousKey;
    }
  }
});

test("loads the Replicate token from a local .env file without printing it", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-dotenv-test-"));
  const serverCopy = path.join(tempDir, "server.js");
  await writeFile(serverCopy, await readFile(path.join(__dirname, "..", "server.js")));
  await writeFile(path.join(tempDir, ".env"), "REPLICATE_API_TOKEN=r8_test-token-only\n");

  const childEnvironment = { ...process.env };
  delete childEnvironment.REPLICATE_API_TOKEN;
  childEnvironment.NODE_PATH = path.join(__dirname, "..", "node_modules");

  try {
    const output = execFileSync(process.execPath, [
      "-e",
      `const app = require(${JSON.stringify(serverCopy)}); process.stdout.write(app.locals.replicate.auth === "r8_test-token-only" ? "loaded" : "missing");`
    ], {
      cwd: tempDir,
      env: childEnvironment,
      encoding: "utf8"
    });
    assert.equal(output, "loaded");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("returns a clear error when the upload is missing", async () => {
  const response = await fetch(`${baseUrl}/api/remove-background`, { method: "POST" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /请先选择/);
});

test("rejects unsupported and spoofed image uploads", async () => {
  const unsupported = new FormData();
  unsupported.append("image", new Blob(["not an image"], { type: "text/plain" }), "notes.txt");
  const unsupportedResponse = await fetch(`${baseUrl}/api/remove-background`, {
    method: "POST",
    body: unsupported
  });
  assert.equal(unsupportedResponse.status, 400);

  const spoofed = new FormData();
  spoofed.append("image", new Blob(["not a png"], { type: "image/png" }), "fake.png");
  const spoofedResponse = await fetch(`${baseUrl}/api/remove-background`, {
    method: "POST",
    body: spoofed
  });
  assert.equal(spoofedResponse.status, 400);
  assert.match((await spoofedResponse.json()).error, /文件内容/);
});

test("rejects uploads larger than 10 MB", async () => {
  const form = new FormData();
  form.append(
    "image",
    new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: "image/jpeg" }),
    "large.jpg"
  );

  const response = await fetch(`${baseUrl}/api/remove-background`, {
    method: "POST",
    body: form
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /10 MB/);
});

test("reports when the Replicate token is not configured", async () => {
  const avatar = await readFile(path.join(__dirname, "..", "微信图片_2026-09-29_140908_233.jpg"));
  const form = new FormData();
  form.append("image", new Blob([avatar], { type: "image/jpeg" }), "avatar.jpg");

  const response = await fetch(`${baseUrl}/api/remove-background`, {
    method: "POST",
    body: form
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /REPLICATE_API_TOKEN/);
});

test("runs the pinned community model through the version predictions endpoint", async () => {
  const avatar = await readFile(path.join(__dirname, "..", "微信图片_2026-09-29_140908_233.jpg"));
  const form = new FormData();
  form.append("image", new Blob([avatar], { type: "image/jpeg" }), "avatar.jpg");

  const replicate = app.locals.replicate;
  const originalFetch = replicate.fetch;
  const previousToken = process.env.REPLICATE_API_TOKEN;
  let predictionUrl;
  let predictionBody;
  process.env.REPLICATE_API_TOKEN = "unit-test-token";
  replicate.fetch = async (url, options) => {
    const requestUrl = String(url);
    if (requestUrl === "https://api.replicate.com/v1/files") {
      return new Response(JSON.stringify({
        id: "test-file",
        urls: { get: "https://replicate.delivery/test/input.jpg" }
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (requestUrl === "https://replicate.delivery/test/result.png") {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "Content-Type": "image/png" }
      });
    }

    predictionUrl = requestUrl;
    predictionBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      id: "test-prediction",
      status: "succeeded",
      output: "https://replicate.delivery/test/result.png"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const response = await fetch(`${baseUrl}/api/remove-background`, {
      method: "POST",
      body: form
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(predictionUrl, "https://api.replicate.com/v1/predictions");
    assert.equal(
      predictionBody.version,
      "95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1"
    );
    assert.equal(
      predictionBody.input.image,
      "https://replicate.delivery/test/input.jpg"
    );
  } finally {
    replicate.fetch = originalFetch;
    if (previousToken === undefined) {
      delete process.env.REPLICATE_API_TOKEN;
    } else {
      process.env.REPLICATE_API_TOKEN = previousToken;
    }
  }
});

test("returns a specific error for Replicate authentication failures", async () => {
  const replicate = app.locals.replicate;
  const originalFetch = replicate.fetch;
  const previousToken = process.env.REPLICATE_API_TOKEN;
  process.env.REPLICATE_API_TOKEN = "unit-test-token";
  replicate.fetch = async () => new Response(
    JSON.stringify({ detail: "Unauthenticated", status: 401 }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );

  try {
    const avatar = await readFile(path.join(__dirname, "..", "微信图片_2026-09-29_140908_233.jpg"));
    const form = new FormData();
    form.append("image", new Blob([avatar], { type: "image/jpeg" }), "avatar.jpg");

    const response = await fetch(`${baseUrl}/api/remove-background`, {
      method: "POST",
      body: form
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /Token 无效或已撤销/);
  } finally {
    replicate.fetch = originalFetch;
    if (previousToken === undefined) {
      delete process.env.REPLICATE_API_TOKEN;
    } else {
      process.env.REPLICATE_API_TOKEN = previousToken;
    }
  }
});
