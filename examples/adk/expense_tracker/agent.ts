import { LlmAgent, FunctionTool } from '@google/adk';
import { z } from 'zod';

interface Expense {
  id: number;
  date: string;
  amount: number;
  category: string;
  description: string;
}

let nextId = 1;
const expenses = new Map<number, Expense>();

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const getCurrentDate = new FunctionTool({
  name: 'get_current_date',
  description: 'Get the current date.',
  execute: () => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} (${WEEKDAYS[now.getDay()]})`;
  },
});

const addExpense = new FunctionTool({
  name: 'add_expense',
  description: 'Add an expense to the tracker.',
  parameters: z.object({
    date: z.string().describe('Date in YYYY-MM-DD format'),
    amount: z.number().describe('Amount spent (positive number)'),
    category: z.string().describe('Category of expense (e.g., food, transport, entertainment)'),
    description: z.string().optional().describe('Optional description'),
  }),
  execute: ({ date, amount, category, description }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
      return 'Error: Invalid date format. Please use YYYY-MM-DD';
    }
    if (amount <= 0) {
      return 'Error: Amount must be positive';
    }
    const id = nextId++;
    expenses.set(id, { id, date, amount, category, description: description ?? '' });
    return `✓ Added $${amount.toFixed(2)} expense for ${category} on ${date}`;
  },
});

const getMonthlySpending = new FunctionTool({
  name: 'get_monthly_spending',
  description: 'Get total spending for a specific month.',
  parameters: z.object({
    year: z.number().describe('Year (e.g., 2024)'),
    month: z.number().describe('Month (1-12)'),
  }),
  execute: ({ year, month }) => {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const matching = [...expenses.values()].filter((e) => e.date.startsWith(prefix));

    const total = matching.reduce((sum, e) => sum + e.amount, 0);
    const byCategory = new Map<string, { total: number; count: number }>();
    for (const e of matching) {
      const entry = byCategory.get(e.category) ?? { total: 0, count: 0 };
      entry.total += e.amount;
      entry.count++;
      byCategory.set(e.category, entry);
    }

    let result = `📊 Spending for ${prefix}\nTotal: $${total.toFixed(2)}\n\n`;
    if (byCategory.size > 0) {
      result += 'By Category:\n';
      const sorted = [...byCategory.entries()].sort((a, b) => b[1].total - a[1].total);
      for (const [cat, { total: amt, count }] of sorted) {
        result += `  • ${cat}: $${amt.toFixed(2)} (${count} transactions)\n`;
      }
    } else {
      result += 'No expenses recorded for this month';
    }
    return result;
  },
});

const searchExpenses = new FunctionTool({
  name: 'search_expenses',
  description: 'Search expenses with optional filters.',
  parameters: z.object({
    category: z.string().optional().describe('Filter by category'),
    start_date: z.string().optional().describe('Start date in YYYY-MM-DD format'),
    end_date: z.string().optional().describe('End date in YYYY-MM-DD format'),
    limit: z.number().optional().describe('Maximum number of results (default 10)'),
  }),
  execute: ({ category, start_date, end_date, limit }) => {
    let results = [...expenses.values()];
    if (category) results = results.filter((e) => e.category === category);
    if (start_date) results = results.filter((e) => e.date >= start_date);
    if (end_date) results = results.filter((e) => e.date <= end_date);
    results.sort((a, b) => b.date.localeCompare(a.date));
    results = results.slice(0, limit ?? 10);

    if (results.length === 0) return 'No expenses found matching your criteria';

    let output = `📝 Found ${results.length} expense(s):\n\n`;
    for (const e of results) {
      output += `• ${e.date} - $${e.amount.toFixed(2)} (${e.category})`;
      if (e.description) output += `: ${e.description}`;
      output += '\n';
    }
    return output;
  },
});

export const rootAgent = new LlmAgent({
  name: 'expense_tracker',
  model: 'gemini-2.5-flash',
  description: 'An AI assistant that helps users track and analyze their expenses',
  instruction: `You are a helpful expense tracking assistant.

When a user mentions an expense:
1. Extract the date (default to today if not specified), amount, and description
2. Ask the user to confirm the category, amount, and date before saving
3. Only call add_expense after explicit user confirmation

When asked about spending:
- Use get_monthly_spending for monthly summaries
- Use search_expenses for filtered queries

Use get_current_date to look up today's date when needed.`,
  tools: [getCurrentDate, addExpense, getMonthlySpending, searchExpenses],
});
