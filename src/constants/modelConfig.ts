export const MODEL_CONFIG = {
    model: "o3-mini",
    temperature: 0.7,
    topP: 0.9,
    topK: 50,
    maxTokens: 40096,
    reasoningEffort: "high",
    store: true
};

export const MODEL_PRICES = {
    inputTokens: 0.0011,     // $1.10 per million input tokens
    outputTokens: 0.0044,    // $4.40 per million output tokens
    cachedInputTokens: 0.00055 // $0.55 per million cached input tokens
}; 