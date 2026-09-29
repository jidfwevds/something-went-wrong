# something-went-wrong

个人学习网站：包含个人介绍、北京天气、学习记录、AI 图片背景去除与文字生成图像功能。后端使用 Node.js 和 Express；Replicate API Token 与 OpenRouter API Key 从本地 `.env` 文件读取，也可以由系统环境变量提供。

去背景使用 [lucataco/remove-bg](https://replicate.com/lucataco/remove-bg/api)，结果为透明 PNG。
服务端固定使用该模型的版本 `95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1`，并通过 SDK 的 `replicate.run()` 等待处理完成。

## 环境要求

- Node.js 20 或更高版本
- 一个 Replicate 账号及其 API Token
- 处理图片时需要联网

## 安装与运行

在 PowerShell 中执行：

```powershell
cd D:\20260929
npm install
Copy-Item .env.example .env
notepad .env
npm start
```

在记事本中，将 `.env` 示例内容替换为你的新 Token，保存并关闭。格式如下（等号两边不要加空格）：

```dotenv
REPLICATE_API_TOKEN=r8_你的新Token
```

`.env` 会由服务器启动时自动加载。若系统环境中已经设置了同名变量，系统环境变量优先于 `.env`。修改 Token 后请重启服务器。也可以完全不创建 `.env`，改为在 PowerShell 中先设置 `$env:REPLICATE_API_TOKEN = "你的新 Token"` 再启动。

在同一个 `.env` 文件内添加 OpenRouter API Key：

```dotenv
OPENROUTER_API_KEY=你的OpenRouter_API_Key
```

OpenRouter Key 可在 [OpenRouter Settings / Keys](https://openrouter.ai/settings/keys) 创建。图像生成功能使用 `openai/gpt-5.4-image-2`，调用可能产生费用；该功能每次只生成 1 张图片。修改 Key 后需要重启 `npm start`。

在浏览器打开 <http://127.0.0.1:3000>。保持运行服务器的终端窗口打开；按 `Ctrl+C` 可以停止服务。

Token 可在 Replicate 账号的 API Tokens 页面创建。请勿把 Token 写入 `index.html`、提交到代码仓库或分享给他人。`.env` 文件已列入 `.gitignore`，示例文件 `.env.example` 不包含真实密钥。

不要将真实 Token 填进 `.env.example`；应只填写本机被 Git 忽略的 `.env` 文件。

## 使用去背景功能

1. 滚动到第三屏「一键去除图片背景」。
2. 点击上传区域选择图片，或把图片拖入区域。
3. 点击「去除背景」，等待模型处理完成。
4. 对比原图和透明背景结果，点击「下载 PNG」保存结果。

支持 JPG、PNG、WebP，单张图片最大 10 MB。图片会上传至 Replicate 托管的模型进行处理。

## 使用文字生成图像

1. 打开第四屏「文字生成图像」。
2. 输入想要生成的画面描述，选择画面比例和图像质量。
3. 点击「生成图像」，等待图片生成后预览并下载。

后端使用 OpenRouter 的 `POST https://openrouter.ai/api/v1/images` 图像生成接口，模型为 `openai/gpt-5.4-image-2`；API Key 只保留在服务器环境中，不会发送给浏览器。价格取决于模型质量和实际用量，请在 OpenRouter 查看账户和模型价格。

## 测试

```powershell
npm test
```
