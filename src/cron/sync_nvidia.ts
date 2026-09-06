/**
 * NVIDIA 免费模型定时同步与模型映射模块
 */

export interface NvidiaFreeModelsResponse {
    success: boolean;
    total?: number;
    model_names?: string[];
    last_updated?: string;
    message?: string;
}

export interface SyncResult {
    success: boolean;
    message: string;
    channelKey?: string;
    gpt52Model?: string | null;
    gpt51Model?: string | null;
    totalModels?: number;
    deploymentMapper?: Record<string, string>;
}

/**
 * 优先级模型关键词（依序查找，第一个为 5.2，下一个为 5.1）
 */
export const priorityKeywords = [
    'moonshot',
    'deepseek',
    'minimax',
];

/**
 * 通用对话模型的备选关键词（若 priorityKeywords 未能填满 5.1，则从此处依次选取）
 */
export const preferredKeywords = [
    'llama',
    'gpt-oss',
    'gemma',
    'mistral',
];

/**
 * 排除非通用对话模型（如纯嵌入、护栏安全模型、图像检测、语音合成、自动驾驶等）
 */
export function isNonChatModel(modelName: string): boolean {
    const lower = modelName.toLowerCase();
    const excludeKeywords = [
        'embed',
        'guard',
        'safety',
        'detector',
        'detection',
        'translate',
        'voice',
        'tts',
        'studiovoice',
        'calibration',
        'transfer',
        'bevformer',
        'sparsedrive',
        'streampetr',
        'bnr',
    ];
    return excludeKeywords.some(kw => lower.includes(kw));
}

/**
 * 选择 gpt-5.2 和 gpt-5.1 模型：
 * 1. 遍历 priorityKeywords，第一个匹配到的为 gpt-5.2，下一个匹配到的为 gpt-5.1；
 * 2. 若 priorityKeywords 没有选满 5.1（或一个都没匹配到），则从 preferredKeywords 中挑选一个作为 gpt-5.1；
 * 3. 若全部未匹配到，则默认取列表最新一个（即 modelNames[0]）。
 */
export function selectModels(modelNames: string[]): {
    selected52: string | null;
    selected51: string | null;
} {
    if (!modelNames || modelNames.length === 0) {
        return { selected52: null, selected51: null };
    }

    let selected52: string | null = null;
    let selected51: string | null = null;

    // 1. 在 priorityKeywords 中按关键词顺序寻找匹配模型
    const matchedPriorityModels: string[] = [];

    // 每个关键词先取第一个未被选过的匹配模型
    for (const kw of priorityKeywords) {
        const found = modelNames.find(
            m => m.toLowerCase().includes(kw) && !matchedPriorityModels.includes(m)
        );
        if (found) {
            matchedPriorityModels.push(found);
        }
    }

    // 若同一关键词下还有多个模型，也放入备选列表
    for (const kw of priorityKeywords) {
        for (const m of modelNames) {
            if (m.toLowerCase().includes(kw) && !matchedPriorityModels.includes(m)) {
                matchedPriorityModels.push(m);
            }
        }
    }

    // 如果找到第一个就是 gpt-5.2
    if (matchedPriorityModels.length > 0) {
        selected52 = matchedPriorityModels[0];
        // 找到了就是 5.2，下一个就是 5.1
        if (matchedPriorityModels.length > 1) {
            selected51 = matchedPriorityModels[1];
        }
    }

    // 如果 5.1 没有从 priorityKeywords 中选出（如只有一个或完全没有匹配），在 preferredKeywords 中选一个
    if (!selected51) {
        for (const kw of preferredKeywords) {
            const found = modelNames.find(
                m => m.toLowerCase().includes(kw) && m !== selected52 && !isNonChatModel(m)
            );
            if (found) {
                selected51 = found;
                break;
            }
        }
    }

    // 若 preferredKeywords 中未命中，尝试从非工具类对话模型中找一个排除 5.2 的模型
    if (!selected51) {
        const nonToolModel = modelNames.find(m => m !== selected52 && !isNonChatModel(m));
        if (nonToolModel) {
            selected51 = nonToolModel;
        }
    }

    // 全部没有默认最新一个（优先排除 5.2，若只有 1 个模型则取第 1 个）
    if (!selected51) {
        selected51 = modelNames.find(m => m !== selected52) || modelNames[0] || null;
    }

    return {
        selected52,
        selected51,
    };
}

/**
 * 兼容旧接口：获取 gpt-5.2 模型
 */
export function selectGpt52Model(modelNames: string[]): string | null {
    return selectModels(modelNames).selected52;
}

/**
 * 兼容旧接口：获取 gpt-5.1 模型
 */
export function selectGpt51Model(modelNames: string[], excludedModels?: Set<string>): string | null {
    return selectModels(modelNames).selected51;
}

/**
 * 构建 deployment_mapper 映射对象
 */
export function buildDeploymentMapper(
    modelNames: string[],
    options?: { syncDirectModels?: boolean }
): {
    mapper: Record<string, string>;
    selected52: string | null;
    selected51: string | null;
} {
    const { selected52, selected51 } = selectModels(modelNames);

    const mapper: Record<string, string> = {};

    if (selected52) {
        mapper['gpt-5.2'] = selected52;
    }
    if (selected51) {
        mapper['gpt-5.1'] = selected51;
    }

    // 若配置开启直连映射，则将所有免费模型的原名也映射到自身
    if (options?.syncDirectModels) {
        for (const name of modelNames) {
            mapper[name] = name;
        }
    }

    return {
        mapper,
        selected52,
        selected51,
    };
}

/**
 * 执行同步 NVIDIA 免费模型并更新数据库渠道
 */
export async function syncNvidiaModels(
    env: CloudflareBindings,
    customApiUrl?: string
): Promise<SyncResult> {
    const apiUrl = customApiUrl || env.NVIDIA_MODELS_API_URL;

    if (!apiUrl) {
        const msg = '[NVIDIA Sync] NVIDIA_MODELS_API_URL 未配置，已跳过定时同步';
        console.warn(msg);
        return { success: false, message: msg };
    }

    console.log(`[NVIDIA Sync] 开始从 ${apiUrl} 获取免费模型列表...`);

    let response: Response;
    try {
        response = await fetch(apiUrl, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'OneAPI-Worker/1.0',
            },
        });
    } catch (err: any) {
        const msg = `[NVIDIA Sync] 请求接口失败: ${err?.message || err}`;
        console.error(msg);
        return { success: false, message: msg };
    }

    if (!response.ok) {
        const msg = `[NVIDIA Sync] 接口返回状态码错误: ${response.status} ${response.statusText}`;
        console.error(msg);
        return { success: false, message: msg };
    }

    let data: NvidiaFreeModelsResponse;
    try {
        data = await response.json<NvidiaFreeModelsResponse>();
    } catch (err: any) {
        const msg = `[NVIDIA Sync] 解析接口响应 JSON 失败: ${err?.message || err}`;
        console.error(msg);
        return { success: false, message: msg };
    }

    if (!data.success || !Array.isArray(data.model_names) || data.model_names.length === 0) {
        const msg = `[NVIDIA Sync] 接口返回数据无效或模型列表为空: ${JSON.stringify(data)}`;
        console.error(msg);
        return { success: false, message: msg };
    }

    const modelNames = data.model_names;
    const syncDirectModels = env.NVIDIA_SYNC_DIRECT_MODELS === 'true' || env.NVIDIA_SYNC_DIRECT_MODELS === '1';
    const { mapper, selected52, selected51 } = buildDeploymentMapper(modelNames, { syncDirectModels });

    console.log(`[NVIDIA Sync] 成功解析到 ${modelNames.length} 个模型:`);
    console.log(`  gpt-5.2 -> ${selected52}`);
    console.log(`  gpt-5.1 -> ${selected51}`);

    // 查找目标 channel（channel_config 表中 key 为 nvidia 或 name 为 nvidia 的记录）
    let targetKey: string | null = null;
    let targetConfig: ChannelConfig | null = null;

    // 1. 尝试精确查找 key = 'nvidia'
    const directRow = await env.DB.prepare(
        'SELECT key, value FROM channel_config WHERE key = ?'
    ).bind('nvidia').first<{ key: string; value: string }>();

    if (directRow) {
        targetKey = directRow.key;
        try {
            targetConfig = JSON.parse(directRow.value) as ChannelConfig;
        } catch (e) {
            console.error('[NVIDIA Sync] 解析已有渠道配置 JSON 失败:', e);
        }
    }

    // 2. 若未通过 key 匹配到，遍历查找 name === 'nvidia'（不区分大小写）
    if (!targetConfig) {
        const allChannels = await env.DB.prepare('SELECT key, value FROM channel_config').all<{ key: string; value: string }>();
        if (allChannels.results && allChannels.results.length > 0) {
            for (const row of allChannels.results) {
                try {
                    const cfg = JSON.parse(row.value) as ChannelConfig;
                    if (
                        row.key.toLowerCase() === 'nvidia' ||
                        (cfg.name && cfg.name.toLowerCase() === 'nvidia')
                    ) {
                        targetKey = row.key;
                        targetConfig = cfg;
                        break;
                    }
                } catch { }
            }
        }
    }

    if (!targetConfig || !targetKey) {
        const msg = `[NVIDIA Sync] 未在数据库中找到 key 或 name 为 'nvidia' 的频道，请先创建 nvidia 频道`;
        console.warn(msg);
        return {
            success: false,
            message: msg,
            gpt52Model: selected52,
            gpt51Model: selected51,
            totalModels: modelNames.length,
            deploymentMapper: mapper,
        };
    }

    // 只修改模型映射 (deployment_mapper)，保留其它所有原有配置
    targetConfig.deployment_mapper = mapper;

    const updateRes = await env.DB.prepare(
        "UPDATE channel_config SET value = ?, updated_at = datetime('now') WHERE key = ?"
    ).bind(JSON.stringify(targetConfig), targetKey).run();

    if (!updateRes.success) {
        const msg = `[NVIDIA Sync] 更新数据库频道 ${targetKey} 失败`;
        console.error(msg);
        return { success: false, message: msg };
    }

    const successMsg = `[NVIDIA Sync] 成功更新频道 [${targetKey}] 的模型映射: gpt-5.2 -> ${selected52}, gpt-5.1 -> ${selected51}`;
    console.log(successMsg);

    return {
        success: true,
        message: successMsg,
        channelKey: targetKey,
        gpt52Model: selected52,
        gpt51Model: selected51,
        totalModels: modelNames.length,
        deploymentMapper: mapper,
    };
}
