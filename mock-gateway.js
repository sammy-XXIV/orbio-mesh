import http from "node:http";
const PORT = process.env.MOCK_PORT || 8788;
http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const body = JSON.parse(b || "{}");
  const promptToks = Math.max(1, Math.ceil(JSON.stringify(body.messages || "").length / 4));
  const completionToks = Math.min(body.max_tokens ?? 64, 40 + Math.floor(Math.random() * 60));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "chatcmpl-mock", object: "chat.completion", model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: "ok (mock)" }, finish_reason: "stop" }],
    usage: { prompt_tokens: promptToks, completion_tokens: completionToks,
             total_tokens: promptToks + completionToks },
  }));
}).listen(PORT, () => console.error(`[mock-gateway] :${PORT}`));
