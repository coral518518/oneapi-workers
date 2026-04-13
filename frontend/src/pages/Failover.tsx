import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/api/client'
import { FailoverConfig } from '@/types'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { PageContainer } from '@/components/ui/page-container'
import {
  RefreshCw,
  Check,
  ShieldAlert,
  Info,
  Plus,
  Trash2,
  X,
  ChevronRight,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'

// ----------------------------------------------------------------
// ChainRow：单条降级链编辑组件
// ----------------------------------------------------------------
interface ChainRowProps {
  chain: string[]
  chainIdx: number
  onUpdate: (idx: number, chain: string[]) => void
  onDelete: (idx: number) => void
}

function ChainRow({ chain, chainIdx, onUpdate, onDelete }: ChainRowProps) {
  const [inputValue, setInputValue] = useState('')
  const [showInput, setShowInput] = useState(false)

  const addModel = () => {
    const model = inputValue.trim()
    if (!model) return
    onUpdate(chainIdx, [...chain, model])
    setInputValue('')
    setShowInput(false)
  }

  const removeModel = (modelIdx: number) => {
    onUpdate(chainIdx, chain.filter((_, i) => i !== modelIdx))
  }

  const moveModel = (modelIdx: number, dir: -1 | 1) => {
    const newChain = [...chain]
    const target = modelIdx + dir
    if (target < 0 || target >= newChain.length) return
    ;[newChain[modelIdx], newChain[target]] = [newChain[target], newChain[modelIdx]]
    onUpdate(chainIdx, newChain)
  }

  return (
    <div className="flex items-start gap-2 p-4 border rounded-xl bg-muted/20 hover:bg-muted/30 transition-colors">
      {/* 链序号 */}
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
        {chainIdx + 1}
      </div>

      {/* 模型序列 */}
      <div className="flex-1 flex flex-wrap items-center gap-1.5">
        {chain.map((model, modelIdx) => (
          <span key={modelIdx} className="inline-flex items-center gap-0.5">
            {/* 箭头（第一个模型不显示） */}
            {modelIdx > 0 && (
              <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            )}

            {/* 模型 badge */}
            <span className="inline-flex items-center gap-1 px-2 py-1 bg-background border rounded-lg text-xs font-mono shadow-sm">
              {/* 上下移动按钮 */}
              <button
                type="button"
                onClick={() => moveModel(modelIdx, -1)}
                disabled={modelIdx === 0}
                className="text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed"
                title="左移（提升优先级）"
              >
                <ArrowUp className="h-2.5 w-2.5" />
              </button>
              <span className="select-none">{model}</span>
              <button
                type="button"
                onClick={() => moveModel(modelIdx, 1)}
                disabled={modelIdx === chain.length - 1}
                className="text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed"
                title="右移（降低优先级）"
              >
                <ArrowDown className="h-2.5 w-2.5" />
              </button>
              {/* 删除该模型 */}
              <button
                type="button"
                onClick={() => removeModel(modelIdx)}
                className="text-muted-foreground hover:text-destructive ml-0.5"
                title="移除此模型"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          </span>
        ))}

        {/* 添加模型 */}
        {showInput ? (
          <div className="inline-flex items-center gap-1 mt-0.5">
            {chain.length > 0 && (
              <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            )}
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addModel()
                if (e.key === 'Escape') { setShowInput(false); setInputValue('') }
              }}
              placeholder="输入模型名称"
              className="h-7 w-44 text-xs font-mono px-2"
              autoFocus
            />
            <button
              type="button"
              onClick={addModel}
              className="h-7 w-7 flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Check className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => { setShowInput(false); setInputValue('') }}
              className="h-7 w-7 flex items-center justify-center rounded-md border hover:bg-muted"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowInput(true)}
            className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs text-muted-foreground border border-dashed hover:border-primary hover:text-primary transition-colors"
          >
            <Plus className="h-3 w-3" />
            {chain.length === 0 ? '添加第一个模型' : '添加降级模型'}
          </button>
        )}
      </div>

      {/* 删除整条链 */}
      <button
        type="button"
        onClick={() => onDelete(chainIdx)}
        className="flex-shrink-0 h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
        title="删除此降级链"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  )
}

// ----------------------------------------------------------------
// Failover 页面主体
// ----------------------------------------------------------------
export function Failover() {
  const { addToast } = useToast()
  const queryClient = useQueryClient()

  const [enabled, setEnabled] = useState(false)
  const [maxRetriesPerModel, setMaxRetriesPerModel] = useState(3)
  const [chains, setChains] = useState<string[][]>([])

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['failover-config'],
    queryFn: async () => {
      const response = await apiClient.getFailoverConfig()
      return response.data as FailoverConfig
    },
  })

  useEffect(() => {
    if (data) {
      setEnabled(data.enabled)
      setMaxRetriesPerModel(data.max_retries_per_model ?? 3)
      setChains(data.chains ?? [])
    }
  }, [data])

  const saveMutation = useMutation({
    mutationFn: async (config: FailoverConfig) => {
      return apiClient.saveFailoverConfig(config)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['failover-config'] })
      addToast('故障切换配置已保存', 'success')
    },
    onError: (error: any) => {
      addToast('保存失败：' + error.message, 'error')
    },
  })

  const handleSave = () => {
    saveMutation.mutate({
      enabled,
      max_retries_per_model: Math.max(1, Math.min(20, maxRetriesPerModel)),
      chains: chains.filter(c => c.length > 0),
    })
  }

  const addChain = () => setChains([...chains, []])

  const updateChain = (idx: number, chain: string[]) => {
    const next = [...chains]
    next[idx] = chain
    setChains(next)
  }

  const deleteChain = (idx: number) => {
    setChains(chains.filter((_, i) => i !== idx))
  }

  return (
    <PageContainer
      title="故障切换配置"
      description="配置 AI 接口自动故障切换与模型降级策略"
      actions={
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
      }
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-muted-foreground">加载中...</span>
          </div>
        </div>
      ) : (
        <div className="max-w-3xl space-y-6">

          {/* 说明卡片 */}
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="p-5">
              <div className="flex gap-3">
                <Info className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                <div className="space-y-2 text-sm">
                  <p className="font-medium text-foreground">工作原理</p>
                  <ol className="space-y-1.5 text-muted-foreground list-decimal list-inside">
                    <li>用户请求 <code className="bg-muted px-1 rounded">gpt-5.4</code></li>
                    <li>随机命中一个 gpt-5.4 提供商，若返回 5xx/429/网络异常，切换同模型其他提供商重试（最多 N 次）</li>
                    <li>gpt-5.4 的所有提供商全部失败 → 降级到 <code className="bg-muted px-1 rounded">gpt-5.2</code>，对 gpt-5.2 各提供商再重试 N 次</li>
                    <li>以此类推，直到链末尾或某次成功返回</li>
                  </ol>
                  <p className="text-xs text-muted-foreground pt-1">
                    <strong>提示：</strong>在频道管理中为同模型的多个提供商设置不同 <code className="bg-muted px-1 rounded">priority</code>，可控制同模型内尝试顺序（优先级高的先试）。
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 基础配置 */}
          <Card>
            <CardContent className="p-5 space-y-5">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-muted-foreground" />
                <h3 className="font-medium">基础设置</h3>
              </div>

              {/* 启用开关 */}
              <div className="flex items-center justify-between p-4 rounded-xl border bg-muted/30">
                <div>
                  <p className="font-medium text-sm">启用故障切换</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    关闭时退回原始行为（随机选一个提供商，无重试无降级）
                  </p>
                </div>
                <button
                  id="failover-toggle"
                  type="button"
                  onClick={() => setEnabled(!enabled)}
                  className={`
                    relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200
                    ${enabled ? 'bg-primary' : 'bg-muted-foreground/30'}
                  `}
                >
                  <span
                    className={`
                      inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200
                      ${enabled ? 'translate-x-6' : 'translate-x-1'}
                    `}
                  />
                </button>
              </div>

              {/* 最大重试次数 */}
              <div className={`space-y-2 transition-opacity duration-200 ${!enabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <Label className="text-sm" htmlFor="max-retries">
                  每个模型的最大尝试次数
                  <span className="text-xs text-muted-foreground ml-2">（含首次请求，范围 1-20）</span>
                </Label>
                <div className="flex items-center gap-3">
                  <Input
                    id="max-retries"
                    type="number"
                    min={1}
                    max={20}
                    value={maxRetriesPerModel}
                    onChange={(e) => setMaxRetriesPerModel(parseInt(e.target.value) || 1)}
                    className="w-24"
                  />
                  <span className="text-sm text-muted-foreground">
                    每个模型级别最多切换 {Math.max(0, maxRetriesPerModel - 1)} 个备用提供商
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 模型降级链 */}
          <Card className={`transition-opacity duration-200 ${!enabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">模型降级链</h3>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    从左到右按优先级排列，左侧模型优先，失败后自动降级到右侧
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={addChain}>
                  <Plus className="h-4 w-4 mr-1" />
                  添加链
                </Button>
              </div>

              {chains.length === 0 ? (
                <button
                  type="button"
                  onClick={addChain}
                  className="w-full py-10 border-2 border-dashed rounded-xl text-sm text-muted-foreground
                    hover:text-foreground hover:border-primary/50 transition-colors flex flex-col items-center justify-center gap-2"
                >
                  <ChevronRight className="h-6 w-6 opacity-30" />
                  <span>暂无降级链，点击添加</span>
                  <span className="text-xs">示例：gpt-5.4 → gpt-5.2 → gpt-5.1</span>
                </button>
              ) : (
                <div className="space-y-2">
                  {chains.map((chain, chainIdx) => (
                    <ChainRow
                      key={chainIdx}
                      chain={chain}
                      chainIdx={chainIdx}
                      onUpdate={updateChain}
                      onDelete={deleteChain}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 保存按钮 */}
          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  保存中...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  保存配置
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </PageContainer>
  )
}
