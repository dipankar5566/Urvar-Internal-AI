import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { config } from '../config.js';
import { MarketResearchAgent } from '../agents/market-research.js';
import { CompetitiveAnalysisAgent } from '../agents/competitive-analysis.js';
import { RdProductDevelopmentAgent } from '../agents/rd-product-development.js';
import { SalesMarketingAgent } from '../agents/sales-marketing.js';
import { LeadGenerationAgent } from '../agents/lead-generation.js';
import { CropDoctorAgent } from '../agents/crop-doctor.js';
import type { AgentRunResult } from '../agents/base.js';

export type AgentType =
  | 'market_research'
  | 'competitive_analysis'
  | 'rd_product_development'
  | 'sales_marketing'
  | 'lead_generation'
  | 'crop_doctor'
  | 'general';

export interface OrchestratorResult extends AgentRunResult {
  agentUsed: AgentType;
}

// Instantiated once — system prompt blocks are cached at startup
const agents = {
  market_research: new MarketResearchAgent(),
  competitive_analysis: new CompetitiveAnalysisAgent(),
  rd_product_development: new RdProductDevelopmentAgent(),
  sales_marketing: new SalesMarketingAgent(),
  lead_generation: new LeadGenerationAgent(),
  crop_doctor: new CropDoctorAgent(),
};

const classifierClient = new Anthropic({ apiKey: config.anthropicApiKey });

// Stage 1: fast keyword routing — no API call
const KEYWORD_RULES: Array<{ pattern: RegExp; agent: AgentType }> = [
  { pattern: /market\s+(size|trend|share|growth|demand|analysis|research|opportunity)/i, agent: 'market_research' },
  { pattern: /consumer\s+(insight|behavior|behaviour|preference|sentiment|demand|segment)/i, agent: 'market_research' },
  { pattern: /pricing\s+(strategy|analysis|competition|benchmark)/i, agent: 'market_research' },
  { pattern: /distribution\s+(channel|network|strategy)/i, agent: 'market_research' },
  { pattern: /(e-?commerce|amazon|flipkart)\s+(strategy|listing|ranking|seo|optimization|opportunity)/i, agent: 'market_research' },
  { pattern: /seasonal\s+(demand|trend|opportunity|pattern)/i, agent: 'market_research' },
  { pattern: /(kharif|rabi)\s+(demand|season|market|trend)/i, agent: 'market_research' },
  { pattern: /target\s+(audience|customer|segment|market)/i, agent: 'market_research' },

  { pattern: /competitor|competition|competitive\s+analysis/i, agent: 'competitive_analysis' },
  { pattern: /(iffco|coromandel|biowin|godrej|multiplex|tata\s+rallis|pi\s+ind)/i, agent: 'competitive_analysis' },
  { pattern: /\bswot\b/i, agent: 'competitive_analysis' },
  { pattern: /market\s+leader/i, agent: 'competitive_analysis' },
  { pattern: /how\s+(does\s+urvar|we)\s+(compare|stack\s+up)/i, agent: 'competitive_analysis' },
  { pattern: /benchmark(ing)?\s+(urvar|our|product)/i, agent: 'competitive_analysis' },

  { pattern: /new\s+product|product\s+(development|innovation|formulation|launch|line)/i, agent: 'rd_product_development' },
  { pattern: /\bR&D\b|research\s+and\s+develop/i, agent: 'rd_product_development' },
  { pattern: /formulation|bio-?stimulant|biofertilizer.*(new|develop)/i, agent: 'rd_product_development' },
  { pattern: /(certification|NPOP|PGS-?India|FCO)\s+(process|pathway|plan|cost|timeline)/i, agent: 'rd_product_development' },
  { pattern: /nano\s+(fertilizer|urea|zinc|technology)/i, agent: 'rd_product_development' },
  { pattern: /(mycorrhiza|rhizobium|azotobacter|trichoderma|azospirillum)\s*(based|inoculant)?/i, agent: 'rd_product_development' },
  { pattern: /packaging\s+(innovation|redesign|improvement|idea)/i, agent: 'rd_product_development' },
  { pattern: /should\s+we\s+(develop|launch|create|make)\s+a\s+new/i, agent: 'rd_product_development' },

  { pattern: /\b(write|create|draft|generate|compose)\s+(a\s+)?(post|caption|email|listing|description|content|copy|message|campaign)/i, agent: 'sales_marketing' },
  { pattern: /amazon\s+(listing|product\s+title|bullet\s+point|description|keyword)/i, agent: 'sales_marketing' },
  { pattern: /(instagram|whatsapp|facebook)\s+(post|caption|message|content)/i, agent: 'sales_marketing' },
  { pattern: /marketing\s+(campaign|strategy|content|material)/i, agent: 'sales_marketing' },
  { pattern: /promotional\s+(content|copy|message|offer)/i, agent: 'sales_marketing' },
  { pattern: /brand\s+(voice|message|positioning|story)/i, agent: 'sales_marketing' },

  { pattern: /\b(find|identify|source|look\s+for)\s+(leads?|distributor|retailer|dealer|partner|reseller)/i, agent: 'lead_generation' },
  { pattern: /(indiamart|tradeindia|justdial)\s+(leads?|supplier|dealer)/i, agent: 'lead_generation' },
  { pattern: /\bFPO\b|farmer\s+producer\s+org/i, agent: 'lead_generation' },
  { pattern: /b2b\s+(prospect|lead|partner|customer)/i, agent: 'lead_generation' },
  { pattern: /outreach\s+(message|template|email)\s+for\s+(dealer|distributor|retailer)/i, agent: 'lead_generation' },

  { pattern: /crop\s+doctor|plant\s+doctor|diagnos(e|is)/i, agent: 'crop_doctor' },
  { pattern: /(yellow|wilting|drooping|dying|spots?|blight|rot|rust|mold|mould)\s+(leaves?|plant|crop)/i, agent: 'crop_doctor' },
  { pattern: /leaves?\s+(are\s+)?(turning\s+)?(yellow|brown|white|black|curl)/i, agent: 'crop_doctor' },
  { pattern: /(disease|pest|insect|caterpillar|aphid|mite|fungus|fungal|bacterial|viral)\s+(attack|damage|problem|issue)/i, agent: 'crop_doctor' },
  { pattern: /nutrient\s+deficiency|deficien(cy|t)\s+(in|of)/i, agent: 'crop_doctor' },
  { pattern: /what('?s|\s+is)\s+wrong\s+with\s+(my\s+)?(plant|crop|leaves?|field)/i, agent: 'crop_doctor' },
  { pattern: /my\s+(plant|crop|leaves?)\s+(is|are)\s+(dying|sick|damaged|affected)/i, agent: 'crop_doctor' },
  { pattern: /how\s+to\s+(treat|cure|fix|control)\s+(disease|pest|blight|rot|rust)/i, agent: 'crop_doctor' },
];

function routeByKeyword(message: string): AgentType | null {
  for (const { pattern, agent } of KEYWORD_RULES) {
    if (pattern.test(message)) return agent;
  }
  return null;
}

// Stage 2: Claude Haiku classifier (fallback)
async function routeByClaude(message: string): Promise<AgentType> {
  const response = await classifierClient.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 20,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: `Classify the following user message into exactly one category for an Indian bio-fertilizer company AI assistant. Respond with ONLY the category name, nothing else.

Categories:
- market_research: market trends, demand, pricing strategy, distribution channels, consumer segments, seasonal patterns, e-commerce
- competitive_analysis: competitors, competitive positioning, SWOT, brand comparison, market share
- rd_product_development: new product development, formulations, certifications, R&D, packaging innovation
- sales_marketing: content creation, Amazon listings, social media posts, WhatsApp messages, campaigns, marketing copy
- lead_generation: finding distributors, retailers, FPOs, B2B leads, outreach messages
- crop_doctor: crop disease diagnosis, pest identification, nutrient deficiency, plant health, treatment advice
- general: greetings, unclear, off-topic, or simple questions about Urvar's own products

Message: "${message.slice(0, 500)}"`,
      },
    ],
  });

  const text = (response.content[0] as { type: string; text?: string }).text?.trim().toLowerCase() ?? '';
  const validTypes: AgentType[] = [
    'market_research', 'competitive_analysis', 'rd_product_development',
    'sales_marketing', 'lead_generation', 'crop_doctor', 'general',
  ];
  return validTypes.includes(text as AgentType) ? (text as AgentType) : 'general';
}

export async function runOrchestrator(
  userMessage: string,
  history: MessageParam[],
): Promise<OrchestratorResult> {
  const agentType = routeByKeyword(userMessage) ?? await routeByClaude(userMessage);

  if (agentType === 'general') {
    return {
      agentUsed: 'general',
      response: 'I can help with market research, competitive analysis, product R&D, sales & marketing content, and lead generation for Urvar Natural. What would you like to explore?',
      iterations: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  }

  const agent = agents[agentType];
  const result = await agent.run(userMessage, history);
  return { ...result, agentUsed: agentType };
}
