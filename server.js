const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

const express = require("express");
const multer = require("multer");
const Replicate = require("replicate");
const { fileTypeFromBuffer } = require("file-type");

const app = express();
app.use(express.json({ limit: "12kb" }));
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "127.0.0.1";
const maxImageSize = 10 * 1024 * 1024;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const removeBackgroundModel =
  "lucataco/remove-bg:95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1";
const imageGenerationModel = "openai/gpt-5.4-image-2";
const openRouterBaseUrl = "https://openrouter.ai/api/v1";
const allowedAspectRatios = new Set([
  "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "auto"
]);
const allowedImageQualities = new Set(["auto", "low", "medium", "high"]);
const replicate = new Replicate();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxImageSize,
    files: 1
  },
  fileFilter(_request, file, callback) {
    if (!allowedImageTypes.has(file.mimetype)) {
      callback(new Error("请选择 JPG、PNG 或 WebP 格式的图片。"));
      return;
    }
    callback(null, true);
  }
});

function getSafeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\br8_[A-Za-z0-9_-]+\b/g, "[REDACTED_TOKEN]");
}

function getReplicateErrorResponse(error) {
  const status = Number(error?.response?.status);
  if (status === 401) {
    return {
      status: 502,
      message: "Replicate API Token 无效或已撤销。请在 PowerShell 中更新环境变量并重启服务。"
    };
  }
  if (status === 402) {
    return {
      status: 502,
      message: "Replicate 账户需要设置付款方式或余额不足，请检查 Replicate 账户账单设置。"
    };
  }
  if (status === 403) {
    return {
      status: 502,
      message: "当前 Replicate Token 没有权限运行此模型，请检查账号和模型访问权限。"
    };
  }
  if (status === 404) {
    return {
      status: 502,
      message: "Replicate 未找到此模型版本，请检查模型版本是否仍可用。"
    };
  }
  if (status === 429) {
    return {
      status: 502,
      message: "Replicate 请求过于频繁，请稍等片刻后重试。"
    };
  }

  return {
    status: 502,
    message: `图片处理失败${status ? `（Replicate HTTP ${status}）` : ""}。${getSafeErrorMessage(error)}`
  };
}

app.get("/", (_request, response) => {
  response.sendFile(path.join(__dirname, "index.html"));
});

app.get("/avatar", (_request, response) => {
  response.sendFile(path.join(__dirname, "微信图片_2026-09-29_140908_233.jpg"));
});

app.get("/healthz", (_request, response) => {
  response.json({ status: "ok" });
});

app.post("/api/generate-image", async (request, response) => {
  const prompt = typeof request.body?.prompt === "string"
    ? request.body.prompt.trim()
    : "";
  const aspectRatio = request.body?.aspectRatio;
  const quality = request.body?.quality;

  if (!prompt) {
    response.status(400).json({ error: "请先填写图像描述。" });
    return;
  }
  if (prompt.length > 2000) {
    response.status(400).json({ error: "图像描述不能超过 2000 个字符。" });
    return;
  }
  if (!allowedAspectRatios.has(aspectRatio)) {
    response.status(400).json({ error: "请选择有效的画面比例。" });
    return;
  }
  if (!allowedImageQualities.has(quality)) {
    response.status(400).json({ error: "请选择有效的图像质量。" });
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    response.status(503).json({
      error: "尚未设置 OPENROUTER_API_KEY。请在项目 .env 文件中配置后重启服务。"
    });
    return;
  }

  try {
    const upstreamResponse = await (app.locals.openRouterFetch || fetch)(
      `${openRouterBaseUrl}/images`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": `http://${host}:${port}`,
          "X-Title": "Personal Learning Homepage"
        },
        body: JSON.stringify({
          model: imageGenerationModel,
          prompt,
          n: 1,
          aspect_ratio: aspectRatio,
          quality
        }),
        signal: AbortSignal.timeout(180000)
      }
    );

    if (!upstreamResponse.ok) {
      const failureBody = await upstreamResponse.json().catch(() => ({}));
      const upstreamMessage =
        failureBody?.error?.message || failureBody?.error?.metadata?.raw ||
        failureBody?.message || `HTTP ${upstreamResponse.status}`;
      const error = new Error(`OpenRouter HTTP ${upstreamResponse.status}: ${upstreamMessage}`);
      error.status = upstreamResponse.status;
      throw error;
    }

    const result = await upstreamResponse.json();
    const imageData = result?.data?.[0];
    const mediaType = imageData?.media_type;
    const base64Image = imageData?.b64_json;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(mediaType) ||
      typeof base64Image !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Image)
    ) {
      throw new Error("OpenRouter 没有返回有效的 Base64 图片。");
    }

    const imageBuffer = Buffer.from(base64Image, "base64");
    const detectedType = await fileTypeFromBuffer(imageBuffer);
    if (!detectedType || detectedType.mime !== mediaType) {
      throw new Error("OpenRouter 返回图片的文件类型与声明不匹配。");
    }

    response
      .status(200)
      .type(detectedType.mime)
      .set(
        "X-Generation-Cost",
        Number.isFinite(result?.usage?.cost) ? result.usage.cost.toFixed(4) : ""
      )
      .send(imageBuffer);
  } catch (error) {
    const status = Number(error?.status);
    const message = getSafeErrorMessage(error);
    console.error("OpenRouter 图像生成失败：", message);
    if (status === 401) {
      response.status(502).json({
        error: "OpenRouter API Key 无效或已撤销，请检查项目 .env 文件并重启服务。"
      });
      return;
    }
    if (status === 402) {
      response.status(502).json({
        error: "OpenRouter 账户余额不足，请检查账户额度后重试。"
      });
      return;
    }
    if (status === 403) {
      response.status(502).json({
        error: "OpenRouter 请求被拒绝，请检查 API Key 状态、模型权限和消费限额。"
      });
      return;
    }
    if (status === 429) {
      response.status(502).json({
        error: "OpenRouter 请求过于频繁，请稍等片刻后重试。"
      });
      return;
    }
    if (status === 400) {
      response.status(502).json({
        error: `OpenRouter 拒绝了本次请求：${message}`
      });
      return;
    }
    response.status(502).json({
      error: `图像生成失败${status ? `（OpenRouter HTTP ${status}）` : ""}。请检查网络或稍后重试。`
    });
  }
});

app.post("/api/remove-background", (request, response, next) => {
  upload.single("image")(request, response, (error) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        response.status(413).json({ error: "图片超过 10 MB，请选择较小的图片。" });
        return;
      }
      if (error instanceof multer.MulterError || error.message.startsWith("请选择")) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
      return;
    }

    next();
  });
}, async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: "请先选择一张图片。" });
    return;
  }

  try {
    const detectedType = await fileTypeFromBuffer(request.file.buffer);
    if (!detectedType || !allowedImageTypes.has(detectedType.mime)) {
      response.status(400).json({ error: "文件内容不是有效的 JPG、PNG 或 WebP 图片。" });
      return;
    }

    if (!process.env.REPLICATE_API_TOKEN) {
      response.status(503).json({
        error: "尚未设置 REPLICATE_API_TOKEN。请按 README 中的说明配置后重启服务。"
      });
      return;
    }

    const output = await replicate.run(removeBackgroundModel, {
      input: { image: request.file.buffer }
    });
    const imageOutput = Array.isArray(output) ? output[0] : output;

    if (!imageOutput || typeof imageOutput.blob !== "function") {
      throw new Error("Replicate 未返回有效的图片文件。");
    }

    const resultBlob = await imageOutput.blob();
    const resultBuffer = Buffer.from(await resultBlob.arrayBuffer());
    if (resultBuffer.length === 0) {
      throw new Error("Replicate 返回了空图片。");
    }

    response
      .status(200)
      .type("png")
      .set("Content-Disposition", 'inline; filename="background-removed.png"')
      .send(resultBuffer);
  } catch (error) {
    const failure = getReplicateErrorResponse(error);
    console.error("Replicate 图片背景去除失败：", getSafeErrorMessage(error));
    response.status(failure.status).json({ error: failure.message });
  }
});

app.use((error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  console.error("服务器请求处理失败：", error);
  response.status(500).json({ error: "服务器暂时无法处理请求，请稍后重试。" });
});

app.locals.replicate = replicate;
app.locals.openRouterFetch = null;

if (require.main === module) {
  app.listen(port, host, () => {
    console.log(`个人网页已启动：http://${host}:${port}`);
  });
}

module.exports = app;
