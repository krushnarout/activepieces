import { ProjectPlanLimits } from '@activepieces/ee-shared'
import { exceptionHandler } from '@activepieces/server-shared'
import {
    ActivepiecesError,
    AiOverageState,
    ApEdition,
    apId,
    ErrorCode,
    isNil,
    PiecesFilterType,
    PlatformPlan,
    ProjectPlan,
    spreadIfDefined,
} from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from '../../../core/db/repo-factory'
import { system } from '../../../helper/system/system'
import { projectService } from '../../../project/project-service'
import { platformPlanService } from '../../platform/platform-plan/platform-plan.service'
import { platformUsageService } from '../../platform/platform-usage-service'
import { ProjectPlanEntity } from './project-plan.entity'

const projectPlanRepo = repoFactory<ProjectPlan>(ProjectPlanEntity)
const edition = system.getEdition()

export const projectLimitsService = (log: FastifyBaseLogger) => ({
    async upsert(
        planLimits: Partial<ProjectPlanLimits>,
        projectId: string,
    ): Promise<ProjectPlan> {
        const projectPlan = await this.getOrCreateDefaultPlan(projectId)
        await projectPlanRepo().update(projectPlan.id, {
            ...spreadIfDefined('tasks', planLimits.tasks),
            ...spreadIfDefined('name', planLimits.nickname),
            ...spreadIfDefined('pieces', planLimits.pieces),
            ...spreadIfDefined('piecesFilterType', planLimits.piecesFilterType),
            ...spreadIfDefined('aiCredits', planLimits.aiCredits),
            ...spreadIfDefined('locked', planLimits.locked),
        })
        return projectPlanRepo().findOneByOrFail({ projectId })
    },
    async getPlanWithPlatformLimits(projectId: string): Promise<ProjectPlan> {
        const projectPlan = await this.getOrCreateDefaultPlan(projectId)
        const platformId = await projectService.getPlatformId(projectId)
        const platformPlan = await platformPlanService(log).getOrCreateForPlatform(platformId)
        return {
            ...projectPlan,
            ...getProjectLimits(projectPlan, platformPlan),
        }
    },

    async getOrCreateDefaultPlan(projectId: string): Promise<ProjectPlan> {
        const existingPlan = await projectPlanRepo().findOneBy({ projectId })

        if (existingPlan) return existingPlan

        await projectPlanRepo().upsert({
            id: apId(),
            projectId,
            pieces: [],
            piecesFilterType: PiecesFilterType.NONE,
            locked: false,
            tasks: null,
            aiCredits: null,
            name: 'free',
        }, ['projectId'])

        return projectPlanRepo().findOneByOrFail({ projectId })
    },

    async checkTasksExceededLimit(projectId: string): Promise<boolean> {
        if (edition === ApEdition.COMMUNITY) {
            return false
        }

        const projectPlan = await this.ensureProjectUnlockedAndGetPlatformPlan(projectId)

        try {
            const platformId = await projectService.getPlatformId(projectId)
            const platformPlan = await platformPlanService(log).getOrCreateForPlatform(platformId)
            const { startDate, endDate } = await platformPlanService(log).getBillingDates(platformPlan)

            const projectTasksUsage = await platformUsageService(log).getProjectUsage({ projectId, metric: 'tasks', startDate, endDate })
            const platformTasksUsage = await platformUsageService(log).getPlatformUsage({ platformId, metric: 'tasks', startDate, endDate })

            const tasksPlatformLimit = await platformReachedLimit({ platformPlan, platformUsage: platformTasksUsage, log, usageType: 'tasks' })
            const tasksPorjectLimit = await projectReachedLimit({ projectPlan, manageProjectsEnabled: platformPlan.manageProjectsEnabled, projectUsage: projectTasksUsage, log, usageType: 'tasks' })

            return tasksPorjectLimit || tasksPlatformLimit
        }
        catch (e) {
            exceptionHandler.handle(e, log)
            return false
        }
    },


    async checkAICreditsExceededLimit(projectId: string): Promise<boolean> {
        if (edition === ApEdition.COMMUNITY) {
            return false
        }

        const projectPlan = await this.ensureProjectUnlockedAndGetPlatformPlan(projectId)

        try {
            const platformId = await projectService.getPlatformId(projectId)
            const platformPlan = await platformPlanService(log).getOrCreateForPlatform(platformId)
            const { startDate, endDate } = await platformPlanService(log).getBillingDates(platformPlan)

            const projectAICreditUsage = await platformUsageService(log).getProjectUsage({ projectId, metric: 'ai_credits', startDate, endDate })
            const platformAICreditUsage = await platformUsageService(log).getPlatformUsage({ platformId, metric: 'ai_credits', startDate, endDate })

            const aiCreditPlatformLimit = await platformReachedLimit({ platformPlan, platformUsage: platformAICreditUsage, log, usageType: 'ai_credits' })
            const aiCreditPorjectLimit = await projectReachedLimit({ projectPlan, manageProjectsEnabled: platformPlan.manageProjectsEnabled, projectUsage: projectAICreditUsage, log, usageType: 'ai_credits' })

            return aiCreditPlatformLimit || aiCreditPorjectLimit
        }
        catch (e) {
            exceptionHandler.handle(e, log)
            return false
        }
    },

    async ensureProjectUnlockedAndGetPlatformPlan(projectId: string): Promise<ProjectPlan> {
        const projectPlan = await projectLimitsService(system.globalLogger()).getOrCreateDefaultPlan(projectId)

        if (projectPlan.locked) {
            throw new ActivepiecesError({
                code: ErrorCode.PROJECT_LOCKED,
                params: {
                    message: 'Project is locked',
                },
            })
        }

        return projectPlan
    },
})



async function projectReachedLimit(params: LimitReachedFromProjectPlanParams): Promise<boolean> {
    const { manageProjectsEnabled, projectPlan, projectUsage, usageType } = params
    if (!manageProjectsEnabled) {
        return false
    }
    const projectLimit = usageType === 'tasks' ? projectPlan.tasks ?? undefined : projectPlan.aiCredits

    if (isNil(projectLimit)) {
        return false
    }
    return projectUsage >= projectLimit
}

async function platformReachedLimit(params: LimitReachedFromPlatformBillingParams): Promise<boolean> {
    if (edition === ApEdition.ENTERPRISE) {
        return false
    }

    const { platformPlan, platformUsage, usageType } = params
    const isOverageEnabled = platformPlan.aiCreditsOverageState === AiOverageState.ALLOWED_AND_ON
    
    const platformLimit = usageType === 'tasks'
        ? platformPlan.tasksLimit
        : platformPlan.includedAiCredits

    if (isNil(platformLimit)) {
        return false
    }

    const totalLimit = usageType === 'ai_credits' && isOverageEnabled
        ? platformLimit + (platformPlan.aiCreditsOverageLimit ?? 0)
        : platformLimit

    return platformUsage >= totalLimit
}

function getProjectLimits(projectPlan: ProjectPlan, platformPlan: PlatformPlan): { tasks: number | undefined, aiCredits: number | undefined } {
    const isOverageEnabled = platformPlan.aiCreditsOverageState === AiOverageState.ALLOWED_AND_ON

    const aiCreditsLimit = ( isOverageEnabled ? (platformPlan.aiCreditsOverageLimit ?? 0) : 0) + platformPlan.includedAiCredits

    if (!platformPlan.manageProjectsEnabled) {
        return {
            aiCredits: aiCreditsLimit,
            tasks: platformPlan?.tasksLimit,
        }
    }

    return {
        tasks: projectPlan.tasks ?? platformPlan?.tasksLimit,
        aiCredits: projectPlan.aiCredits ?? aiCreditsLimit,
    }

}

type LimitReachedFromProjectPlanParams = {
    projectPlan: ProjectPlan
    manageProjectsEnabled: boolean
    usageType: 'tasks' | 'ai_credits'
    log: FastifyBaseLogger
    projectUsage: number
}

type LimitReachedFromPlatformBillingParams = {
    platformPlan: PlatformPlan
    usageType: 'tasks' | 'ai_credits' 
    log: FastifyBaseLogger
    platformUsage: number
}