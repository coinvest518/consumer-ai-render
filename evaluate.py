import os
from langsmith import Client, wrappers
from openevals.llm import create_llm_as_judge
from openevals.prompts import CORRECTNESS_PROMPT
from langchain_google_genai import ChatGoogleGenerativeAI

# Set environment variables (assuming they are set)
os.environ["LANGSMITH_TRACING"] = "true"
os.environ["LANGSMITH_ENDPOINT"] = "https://api.smith.langchain.com"
# LangSmith API key should be set as environment variable LANGSMITH_API_KEY
if not os.getenv("LANGSMITH_API_KEY"):
    raise ValueError("Please set the LANGSMITH_API_KEY environment variable")
os.environ["LANGSMITH_API_KEY"] = os.getenv("LANGSMITH_API_KEY")

# Google API key should be set as environment variable GOOGLE_API_KEY
if not os.getenv("GOOGLE_API_KEY"):
    raise ValueError("Please set the GOOGLE_API_KEY environment variable")

# Wrap the Google Generative AI client for LangSmith tracing
openai_client = wrappers.wrap_google_generative_ai(ChatGoogleGenerativeAI(api_key=os.environ["GOOGLE_API_KEY"], model="gemini-1.5-flash"))

# Define the application logic to evaluate.
# Dataset inputs are automatically sent to this target function.
def target(inputs: dict) -> dict:
    response = openai_client.invoke(
        [
            {"role": "system", "content": "Answer the following question accurately"},
            {"role": "user", "content": inputs["question"]},
        ]
    )
    return {"answer": response.content}

client = Client()

dataset = client.create_dataset(
    dataset_name="ds-somber-trailer-42", description="A sample dataset in LangSmith."
)
examples = [
    {
        "inputs": {"question": "Which country is Mount Kilimanjaro located in?"},
        "outputs": {"answer": "Mount Kilimanjaro is located in Tanzania."},
    },
    {
        "inputs": {"question": "What is Earth's lowest point?"},
        "outputs": {"answer": "Earth's lowest point is The Dead Sea."},
    },
]

# Create examples in the dataset
for example in examples:
    client.create_example(
        dataset_id=dataset.id,
        inputs=example["inputs"],
        outputs=example["outputs"],
    )

# Define an LLM-as-a-judge evaluator to evaluate correctness of the output
def correctness_evaluator(inputs: dict, outputs: dict, reference_outputs: dict):
    evaluator = create_llm_as_judge(
        prompt=CORRECTNESS_PROMPT,
        model="gemini-1.5-flash",  # Using Gemini for evaluation
        feedback_key="correctness",
    )
    eval_result = evaluator(
        inputs=inputs, outputs=outputs, reference_outputs=reference_outputs
    )
    return eval_result

# Run the evaluation
experiment_results = client.evaluate(
    target,
    data="ds-somber-trailer-42",
    evaluators=[correctness_evaluator],
    experiment_prefix="experiment-quickstart-excellent-curiosity-99",
    max_concurrency=2,
)

print("Evaluation completed. Results:", experiment_results)