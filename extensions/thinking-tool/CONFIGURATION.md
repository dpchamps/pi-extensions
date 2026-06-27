# VibeThinker-3B Thinking Tool

This extension provides a `think` tool that calls the VibeThinker-3B model for complex reasoning tasks.

## Configuration

Set these environment variables in your shell or `.env` file:

```bash
# VibeThinker API endpoint
export VIBETHINKER_ENDPOINT="http://192.168.0.40:8000/v1"

# Model ID (optional, defaults to WeiboAI/VibeThinker-3B)
export VIBETHINKER_MODEL_ID="WeiboAI/VibeThinker-3B"

# Generation settings
export VIBETHINKER_MAX_TOKENS="8192"
export VIBETHINKER_TEMPERATURE="0.6"
export VIBETHINKER_TOP_P="0.95"
```

## Running VibeThinker-3B

### With vLLM (Recommended)

```bash
# Pull and run with vLLM
python -m vllm.entrypoints.openai.api_server \
  --model WeiboAI/VibeThinker-3B \
  --host 0.0.0.0 \
  --port 8000 \
  --max-model-len 32768
```

### With Transformers

```bash
# Create a simple server script
cat > server.py << 'EOF'
from transformers import AutoModelForCausalLM, AutoTokenizer
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
model_name = "WeiboAI/VibeThinker-3B"
model = AutoModelForCausalLM.from_pretrained(
    model_name,
    low_cpu_mem_usage=True,
    torch_dtype="bfloat16",
    device_map="auto",
)
tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)

class Prompt(BaseModel):
    message: str

@app.post("/v1/chat/completions")
async def chat(prompt: Prompt):
    messages = [{"role": "user", "content": prompt.message}]
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    model_inputs = tokenizer([text], return_tensors="pt").to(model.device)
    
    generated_ids = model.generate(**model_inputs, max_new_tokens=8192)
    response = tokenizer.batch_decode(generated_ids, skip_special_tokens=True)[0]
    
    return {
        "choices": [{
            "message": {
                "content": response,
                "reasoning": " reasoning completed"
            }
        }]
    }

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
EOF

# Install dependencies and run
pip install transformers uvicorn fastapi pydantic
python server.py
```

## Using the Tool in pi

Once the extension is loaded and VibeThinker is running:

1. The `think` tool will appear in the agent's tool list
2. When the agent determines a task requires reasoning, it will call `think` with the prompt
3. The tool returns both reasoning trace and final answer
4. The agent can incorporate this into its response

Example prompt that might trigger the tool:
```
Solve this math problem: If x + y = 10 and x - y = 4, what is x?
```

The agent will:
1. Recognize this as a reasoning task
2. Call `think` with the problem
3. Get back reasoning + answer
4. Present the answer to you

## Troubleshooting

### Connection Refused
- Check that VibeThinker is running at the configured endpoint
- Verify firewall rules allow access to port 8000
- Test with `curl http://192.168.0.40:8000/v1/models`

### Model Not Found
- Ensure the model ID matches what's loaded in your VibeThinker instance
- Check `curl http://192.168.0.40:8000/v1/models` for available models

### Timeout Errors
- Increase `VIBETHINKER_TIMEOUT` environment variable
- Check VibeThinker logs for slow inference
- Consider reducing `VIBETHINKER_MAX_TOKENS` for faster responses
