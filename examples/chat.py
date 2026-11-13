"""pip install openai; set MODEL_DOCK_API_KEY and optionally MODEL_DOCK_MODEL."""
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ.get("MODEL_DOCK_BASE_URL", "http://127.0.0.1:4317/v1"),
    api_key=os.environ["MODEL_DOCK_API_KEY"],
    max_retries=0,
)
stream = client.chat.completions.create(
    model=os.environ.get("MODEL_DOCK_MODEL", "chat-default"),
    messages=[{"role": "user", "content": "你好，请用一句话介绍自己。"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
print()
