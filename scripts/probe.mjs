const endpoint = "https://demos.exa.ai/chatbot-demo/api/chat/stream";

const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: "Say hi in exactly three words.",
    history: [],
    exaEnabled: false,
    model: "google/gemini-2.5-flash",
    searchType: "instant",
  }),
});

console.log(response.status, response.headers.get("content-type"));

const reader = response.body.getReader();
const decoder = new TextDecoder();
let text = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  text += decoder.decode(value, { stream: true });
}

console.log(text.trim());
