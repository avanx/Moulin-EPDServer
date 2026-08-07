export const adaptData = (data: { text?: string }, config: { text: string }) => ({ text: data.text ?? config.text });
