import { LlmAgent, FunctionTool, Runner, InMemorySessionService, isFinalResponse } from '@google/adk';
import { Content } from '@google/genai';
import { ADKGuardrailsPlugin } from '../../../src/plugins/adk.js';
import { z } from 'zod';

const addTodoItems = new FunctionTool({
  name: 'add_todo_items',
  description: 'Writes a list of detailed TODO tasks to storage.',
  parameters: z.object({
    tasks: z.array(z.string()).describe('A list of detailed tasks to be added'),
  }),
  execute: ({ tasks }) => {
    console.log('Items added:', tasks);
  },
});

const notifyUser = new FunctionTool({
  name: 'notify_user',
  description: 'Notify user any text messages.',
  parameters: z.object({
    message: z.string().describe('Text message to send to user'),
  }),
  execute: ({ message }) => {
    console.log('User sees:', message);
    return { status: 'success' };
  },
});

const plugin = new ADKGuardrailsPlugin({ loadDotenv: true });

export const rootAgent = new LlmAgent({
  name: 'todo_list_agent',
  model: 'gemini-2.5-flash',
  description: 'generate todo list items for the user',
  instruction: `You are a project manager. When a user gives you a task,
break it down into 5-10 actionable steps.
Once you have the steps, use the 'add_todo_items' tool to save them. Call the tool with 1 task at a time to optimize updating frequency.

The user will only see messages from you if you notify them via 'notify_user' tool. Notify the user while you are adding tasks.`,
  tools: [addTodoItems, notifyUser],
  generateContentConfig: plugin.contentConfig as never,
  beforeModelCallback: (args) => {
    plugin.beforeModelCallback(args);
    return undefined;
  },
});

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''))) {
  const sessionService = new InMemorySessionService();
  const runner = new Runner({
    agent: rootAgent,
    appName: 'todo_app',
    sessionService,
  });

  const userId = 'user_123';
  const sessionId = 'session_456';

  await sessionService.createSession({ appName: 'todo_app', userId, sessionId });

  const userQuery = "I need to clean up my garage it's a mess.";
  console.log(`User: ${userQuery}\n${'—'.repeat(20)}`);

  const content: Content = { role: 'user', parts: [{ text: userQuery }] };

  for await (const event of runner.runAsync({ userId, sessionId, newMessage: content })) {
    if (isFinalResponse(event)) {
      const text = event.content?.parts?.[0]?.text;
      if (text) console.log(`Agent Response: ${text}`);
    }
  }
}
