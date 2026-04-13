export interface Channel {
  key: string
  value: string | ChannelConfig
  usage?: number
}

export interface ChannelConfig {
  name: string
  type: 'openai' | 'azure-openai' | 'claude' | 'claude-to-openai' | 'openai-responses' | 'azure-openai-responses'
  endpoint: string
  api_key: string
  api_version?: string
  deployment_mapper?: Record<string, string>
  priority?: number // 故障切换优先级，越大越优先，默认 0
}

export interface FailoverConfig {
  enabled: boolean
  max_retries_per_model: number  // 每个模型级别最大尝试次数（含首次）
  chains: string[][]             // 有序模型降级链
}

export interface Token {
  key: string
  value: string | TokenConfig
  usage?: number
}

export interface TokenConfig {
  name: string
  channel_keys?: string[]
  total_quota: number
}

export interface PricingModel {
  input: number
  output: number
  cache?: number
}

export type PricingConfig = Record<string, PricingModel>

export interface ApiResponse<T = any> {
  data?: T
  error?: string
  message?: string
}

export interface TestRequest {
  model: string
  messages?: Array<{
    role: string
    content: string
  }>
  prompt?: string
  max_tokens?: number
  temperature?: number
  stream?: boolean
}

export interface TestResponse {
  id?: string
  model?: string
  choices?: Array<{
    message?: {
      role: string
      content: string
    }
    text?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}
