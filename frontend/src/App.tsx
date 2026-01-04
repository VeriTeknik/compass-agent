import { useState, useRef, useEffect, FormEvent, KeyboardEvent } from 'react';
import { Send, Loader2, Bot, User, Compass, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';

interface ModelResponse {
  model: string;
  answer: string;
  reasoning?: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  consensus?: {
    verdict: string;
    confidence: string;
    agreementScore: number;
  };
  modelsUsed?: string[];
  modelResponses?: ModelResponse[];
  failedModels?: string[];
}

interface AgentStatus {
  state: string;
  configured_models: string[];
  available_models: Record<string, boolean>;
}

// Helper to get model display name and provider color
function getModelInfo(modelId: string): { name: string; color: string } {
  const lowerModel = modelId.toLowerCase();
  if (lowerModel.includes('gpt') || lowerModel.includes('openai')) {
    return { name: modelId.split('-').slice(0, 2).join('-'), color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
  }
  if (lowerModel.includes('claude') || lowerModel.includes('anthropic')) {
    return { name: 'Claude', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' };
  }
  if (lowerModel.includes('gemini') || lowerModel.includes('google')) {
    return { name: 'Gemini', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' };
  }
  return { name: modelId, color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' };
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [expandedResponses, setExpandedResponses] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const toggleResponseExpanded = (messageId: string) => {
    setExpandedResponses((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  // Fetch agent status on mount
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await fetch('/status');
        if (response.ok) {
          const data = await response.json();
          setAgentStatus(data);
        }
      } catch (error) {
        console.error('Failed to fetch agent status:', error);
      }
    };
    fetchStatus();
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage.content }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.response,
        timestamp: new Date(),
        consensus: data.consensus,
        modelsUsed: data.models_used,
        modelResponses: data.model_responses,
        failedModels: data.failed_models,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Chat error:', error);
      const errorMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'Sorry, there was an error processing your request. Please try again.',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setInput(suggestion);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
            <Compass className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
              Compass Agent
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              AI Jury/Oracle - Multi-model Consensus
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Active Models */}
          {agentStatus?.configured_models && agentStatus.configured_models.length > 0 && (
            <div className="hidden sm:flex items-center gap-1.5">
              <span className="text-xs text-slate-500 dark:text-slate-400 mr-1">Models:</span>
              {agentStatus.configured_models.map((model) => {
                const { name, color } = getModelInfo(model);
                return (
                  <span
                    key={model}
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${color}`}
                    title={model}
                  >
                    {name}
                  </span>
                );
              })}
            </div>
          )}
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            Online
          </span>
        </div>
      </header>

      {/* Chat Area */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-4 py-6">
          {messages.length === 0 ? (
            <div className="text-center space-y-4 py-12">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <Compass className="w-8 h-8 text-white" />
              </div>
              <div>
                <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
                  Welcome to Compass
                </h2>
                <p className="text-slate-500 dark:text-slate-400 mt-2 max-w-md mx-auto">
                  I'm an AI Jury/Oracle that uses multi-model consensus to provide
                  balanced, thoughtful responses. Ask me anything!
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2 pt-4">
                {[
                  'What can you help me with?',
                  'Explain consensus mechanisms',
                  'Compare different approaches',
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => handleSuggestionClick(suggestion)}
                    className="px-4 py-2 rounded-full text-sm bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex gap-3 ${
                    message.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  {message.role === 'assistant' && (
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center flex-shrink-0">
                      <Bot className="w-5 h-5 text-white" />
                    </div>
                  )}
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                      message.role === 'user'
                        ? 'bg-gradient-to-r from-blue-500 to-purple-600 text-white'
                        : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 shadow-sm border border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{message.content}</p>
                    {message.consensus && (
                      <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-600 space-y-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span className="flex items-center gap-1">
                            <span className="font-medium">Verdict:</span>
                            <span className={
                              message.consensus.verdict === 'unanimous'
                                ? 'text-green-600 dark:text-green-400'
                                : message.consensus.verdict === 'split'
                                ? 'text-yellow-600 dark:text-yellow-400'
                                : 'text-red-600 dark:text-red-400'
                            }>
                              {message.consensus.verdict}
                            </span>
                          </span>
                          <span className="text-slate-300 dark:text-slate-600">|</span>
                          <span>
                            <span className="font-medium">Confidence:</span>{' '}
                            {message.consensus.confidence}
                          </span>
                          <span className="text-slate-300 dark:text-slate-600">|</span>
                          <span>
                            <span className="font-medium">Agreement:</span>{' '}
                            {(message.consensus.agreementScore * 100).toFixed(0)}%
                          </span>
                        </div>
                        {message.modelsUsed && message.modelsUsed.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="text-xs text-slate-400 dark:text-slate-500">Responded:</span>
                            {message.modelsUsed.map((model) => {
                              const { name, color } = getModelInfo(model);
                              return (
                                <span
                                  key={model}
                                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${color}`}
                                  title={model}
                                >
                                  {name}
                                </span>
                              );
                            })}
                          </div>
                        )}
                        {/* Failed Models Warning */}
                        {message.failedModels && message.failedModels.length > 0 && (
                          <div className="flex items-center gap-1 text-xs text-red-500 dark:text-red-400">
                            <AlertCircle className="w-3 h-3" />
                            <span>Failed: {message.failedModels.join(', ')}</span>
                          </div>
                        )}
                        {/* Individual Model Responses Toggle */}
                        {message.modelResponses && message.modelResponses.length > 0 && (
                          <button
                            onClick={() => toggleResponseExpanded(message.id)}
                            className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 transition-colors mt-1"
                          >
                            {expandedResponses.has(message.id) ? (
                              <ChevronDown className="w-3 h-3" />
                            ) : (
                              <ChevronRight className="w-3 h-3" />
                            )}
                            <span>
                              {expandedResponses.has(message.id) ? 'Hide' : 'Show'} individual responses ({message.modelResponses.length})
                            </span>
                          </button>
                        )}
                      </div>
                    )}
                    {/* Expanded Individual Model Responses */}
                    {message.modelResponses && message.modelResponses.length > 0 && expandedResponses.has(message.id) && (
                      <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-600 space-y-3">
                        <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                          Individual AI Responses
                        </h4>
                        {message.modelResponses.map((resp, idx) => {
                          const { name, color } = getModelInfo(resp.model);
                          return (
                            <div key={idx} className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-3 space-y-2">
                              <div className="flex items-center gap-2">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}>
                                  {name}
                                </span>
                                <span className="text-[10px] text-slate-400 dark:text-slate-500 truncate" title={resp.model}>
                                  {resp.model}
                                </span>
                              </div>
                              <p className="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap">
                                {resp.answer}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {message.role === 'user' && (
                    <div className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-slate-700 flex items-center justify-center flex-shrink-0">
                      <User className="w-5 h-5 text-slate-600 dark:text-slate-300" />
                    </div>
                  )}
                </div>
              ))}
              {isLoading && (
                <div className="flex gap-3 justify-start">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center flex-shrink-0">
                    <Bot className="w-5 h-5 text-white" />
                  </div>
                  <div className="bg-white dark:bg-slate-800 rounded-2xl px-4 py-3 shadow-sm border border-slate-200 dark:border-slate-700">
                    <div className="flex items-center gap-2 text-slate-500">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Consulting multiple models...</span>
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </main>

      {/* Input Area */}
      <div className="border-t border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm p-4">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto">
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Compass anything..."
              rows={1}
              className="flex-1 min-h-[48px] max-h-[200px] px-4 py-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="h-12 w-12 rounded-xl bg-gradient-to-r from-blue-500 to-purple-600 text-white flex items-center justify-center hover:from-blue-600 hover:to-purple-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </button>
          </div>
          <p className="text-xs text-center text-slate-400 mt-2">
            Compass uses multi-model consensus for balanced responses
          </p>
        </form>
      </div>
    </div>
  );
}
