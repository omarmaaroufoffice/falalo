import { OpenAI } from 'openai';
import { LogManager } from '../logManager';
import { TaskPlan, TaskStep } from '../interfaces/types';
import { TASK_PLANNING_PROMPT } from '../constants/prompts';

let model: OpenAI | null = null;

export async function initializeTaskPlanner(openai: OpenAI): Promise<void> {
    model = openai;

    const logger = LogManager.getInstance();
    
    try {
        logger.log('Testing task planner...', { type: 'info' });
        
        const testResponse = await openai.chat.completions.create({
            model: 'o3-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are a task planning assistant.'
                },
                {
                    role: 'user',
                    content: 'Test task planning.'
                }
            ],
            reasoning_effort: 'medium',
            store: true
        });

        if (!testResponse.choices || testResponse.choices.length === 0) {
            throw new Error('Task planner initialization failed');
        }

        logger.log('Task planner initialized successfully', { type: 'info' });
    } catch (error) {
        logger.logError(error, 'Task planner initialization');
        throw error;
    }
}

export async function evaluateRequest(model: OpenAI, request: string): Promise<TaskPlan> {
    const logger = LogManager.getInstance();
    
    try {
        if (!request || typeof request !== 'string' || request.trim().length === 0) {
            throw new Error('Invalid request: Request cannot be empty');
        }

        logger.log('Evaluating request with task planner...', { type: 'info' });
        
        const completion = await model.chat.completions.create({
            model: 'o3-mini',
            messages: [
                {
                    role: 'system',
                    content: TASK_PLANNING_PROMPT
                },
                {
                    role: 'user',
                    content: `Please analyze this request and break it down into steps: ${request}`
                }
            ],
            reasoning_effort: 'medium',
            store: true
        });

        const response = completion.choices[0]?.message?.content;
        if (!response) {
            throw new Error('No response from task planner');
        }

        const steps = response.split('\n')
            .filter(line => line.trim() && !line.startsWith('```') && !line.startsWith('Here') && !line.startsWith('I will'))
            .map((line, index) => ({
                id: index + 1,
                description: line.trim(),
                status: 'pending' as const,
                files: [],
                dependencies: []
            }));

        if (steps.length === 0) {
            throw new Error('No valid steps could be extracted from the response');
        }

        const taskPlan: TaskPlan = {
            steps,
            currentStep: 0,
            totalSteps: steps.length,
            request,
            originalRequest: request,
            description: `Task plan for: ${request}`,
            estimatedTime: `${Math.ceil(steps.length * 5)} minutes`
        };

        logger.log(`Created task plan with ${steps.length} steps`, { type: 'info' });
        return taskPlan;
    } catch (error) {
        logger.logError(error, 'Task planning');
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
            id: index + 1,
            description: step.description,
            status: 'pending',
            files: [],
            dependencies: Array.isArray(step.dependencies) ? step.dependencies.map(Number) : []
        };
    });

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
        request: originalRequest,
        originalRequest,
        description,
        estimatedTime
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
        console.error(`Step ${stepIndex + 1} failed: ${plan.steps[stepIndex].description}`);
    }
}

export function getNextStep(plan: TaskPlan): TaskStep | null {
    if (plan.currentStep >= plan.totalSteps) {
        return null;
    }

    const nextStep = plan.steps[plan.currentStep];
    
    // Check if all dependencies are completed
    const unmetDependencies = nextStep.dependencies
        .map(Number)
        .filter(depIndex => {
            return depIndex >= 0 && depIndex < plan.steps.length && plan.steps[depIndex].status !== 'completed';
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