import { OpenAI } from 'openai';
import { TaskPlan, TaskStep } from '../interfaces/types';
import { TASK_PLANNING_PROMPT } from '../constants/prompts';

let model: OpenAI | null = null;

export function initializeTaskPlanner(openai: OpenAI) {
    model = openai;
}

export async function evaluateRequest(request: string): Promise<TaskPlan> {
    if (!model) {
        throw new Error('Task planner not initialized');
    }

    try {
        const completion = await model.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: TASK_PLANNING_PROMPT
                },
                {
                    role: 'user',
                    content: `Please analyze this request and provide a JSON response with the task plan: ${request}`
                }
            ],
            temperature: 0.3,
            max_tokens: 1000,
            response_format: { type: "json_object" }
        });

        const response = completion.choices[0]?.message?.content;
        if (!response) {
            throw new Error('Empty response from AI');
        }

        try {
            // Clean the response before parsing
            const cleanedResponse = response.replace(/```json\s*|\s*```/g, '').trim();
            const parsedResponse = JSON.parse(cleanedResponse);

            // Validate the response structure
            if (!parsedResponse || !Array.isArray(parsedResponse.steps)) {
                throw new Error('Invalid response structure: missing steps array');
            }

            return validateAndNormalizeTaskPlan(parsedResponse, request);
        } catch (parseError) {
            console.error('Raw AI response:', response);
            console.error('Parse error:', parseError);
            
            // Attempt to create a basic task plan from the response
            const fallbackPlan = {
                steps: [{
                    description: 'Process user request',
                    dependencies: []
                }],
                description: 'Basic task plan',
                estimatedTime: '5 minutes'
            };
            
            return validateAndNormalizeTaskPlan(fallbackPlan, request);
        }
    } catch (error) {
        console.error('Error evaluating request:', error);
        throw error;
    }
}

function validateAndNormalizeTaskPlan(plan: any, originalRequest: string): TaskPlan {
    if (!plan || typeof plan !== 'object') {
        throw new Error('Invalid task plan: not an object');
    }

    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
        throw new Error('Invalid task plan: missing or empty steps array');
    }

    const normalizedSteps: TaskStep[] = plan.steps.map((step: any, index: number) => {
        if (!step || typeof step !== 'object') {
            throw new Error(`Invalid step at index ${index}: not an object`);
        }

        if (typeof step.description !== 'string' || !step.description) {
            throw new Error(`Invalid step at index ${index}: missing or invalid description`);
        }

        return {
            description: step.description,
            status: 'pending',
            files: [],
            dependencies: Array.isArray(step.dependencies) ? step.dependencies : []
        };
    });

    // Extract or generate description and estimatedTime
    const description = typeof plan.description === 'string' && plan.description
        ? plan.description
        : `Task plan for: ${originalRequest}`;

    const estimatedTime = typeof plan.estimatedTime === 'string' && plan.estimatedTime
        ? plan.estimatedTime
        : `${Math.ceil(normalizedSteps.length * 5)} minutes`;

    return {
        steps: normalizedSteps,
        currentStep: 0,
        totalSteps: normalizedSteps.length,
        originalRequest,
        description,
        estimatedTime,
        request: originalRequest
    };
}

export async function updateTaskProgress(plan: TaskPlan, stepIndex: number, status: 'pending' | 'in-progress' | 'completed' | 'failed'): Promise<void> {
    if (stepIndex < 0 || stepIndex >= plan.steps.length) {
        throw new Error('Invalid step index');
    }

    plan.steps[stepIndex].status = status;

    if (status === 'completed') {
        plan.currentStep = Math.min(plan.currentStep + 1, plan.totalSteps);
    } else if (status === 'failed') {
        // Optionally handle failed steps differently
        console.error(`Step ${stepIndex + 1} failed: ${plan.steps[stepIndex].description}`);
    }
}

export function getNextStep(plan: TaskPlan): TaskStep | null {
    if (plan.currentStep >= plan.totalSteps) {
        return null;
    }

    const nextStep = plan.steps[plan.currentStep];
    
    // Check if all dependencies are completed
    const unmetDependencies = nextStep.dependencies.filter(depIndex => {
        return depIndex < plan.steps.length && plan.steps[depIndex].status !== 'completed';
    });

    if (unmetDependencies.length > 0) {
        console.warn('Dependencies not met for step:', nextStep.description);
        console.warn('Waiting for steps:', unmetDependencies.map(i => i + 1).join(', '));
        return null;
    }

    return nextStep;
}

export function isTaskComplete(plan: TaskPlan): boolean {
    return plan.steps.every(step => step.status === 'completed');
} 