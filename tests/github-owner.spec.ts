import { describe, expect, it } from 'vitest'
import { commentTrigger, issueTrigger } from '../src/sources/github-trigger.ts'

const login = 'tonexue1'
const prefix = '[DSH任务]'
const user = { login, type: 'User' }
const issue = (body: string) => ({ number: 1, title: 'Read-only check', body, user,
  created_at: '2026-11-04T00:00:00Z', html_url: 'https://github.com/tonexue1/novelAgentV2/issues/1' })
const comment = (body: string) => ({ id: 2, body, user, created_at: '2026-11-04T00:00:00Z' })

describe('explicit requests from the execution account', () => {
  it('admits a deliberately marked owner Issue when owner mode is enabled', () => {
    expect(issueTrigger(issue('[DSH任务] @tonexue1 run existing tests'), login, prefix))
      .toMatchObject({ human: true, addressed: 'mention', actor: { id: login } })
  })
  it('admits a deliberately marked owner follow-up when owner mode is enabled', () => {
    expect(commentTrigger(comment('[DSH任务] @tonexue1 stop this task'), { number: 1, isPr: false }, 'conversation', login, prefix))
      .toMatchObject({ human: true, addressed: 'mention', actor: { id: login } })
  })
  it('keeps the default self-message suppression without explicit opt-in', () => {
    expect(issueTrigger(issue('[DSH任务] @tonexue1 run tests'), login).human).toBe(false)
  })
  it.each([
    'A normal comment @tonexue1',
    '[DSH任务] run tests without addressing the account',
    'Quoted request:\n[DSH任务] @tonexue1 run tests',
    '[DSH任务]extra @tonexue1 run tests',
    '[DSH任务] @tonexue1-other run tests',
    'This is by an automated agent, not a human.\n[DSH任务] @tonexue1 run tests',
    '[DSH任务] @tonexue1 run tests\n\n<!-- dsh-superagent:reply-1 -->',
  ])('never turns an ordinary or automatically delivered self-message into a human request: %s', body => {
    expect(commentTrigger(comment(body), { number: 1, isPr: false }, 'conversation', login, prefix).human).toBe(false)
  })
})
