import type { TrackerSnapshot } from '../../shared/types.js'

// One adapter per tracker. Each maps its own objects onto the common model in shared/types.ts:
//   work item  GitHub issue · GitLab issue · Jira story, task or bug
//   epic       GitHub Epic issue type with sub-issues · GitLab epic · Jira epic
//   milestone  GitHub milestone · GitLab milestone or iteration · Jira fix version or sprint
//   change     GitHub pull request · GitLab merge request · the PR or MR linked in Jira's development panel
// v1 ships GitHub. GitLab and Jira implement this same interface (docs/ROADMAP.md).
export interface TrackerAdapter {
  readonly provider: TrackerSnapshot['provider']
  readonly repo: string
  snapshot(): Promise<TrackerSnapshot>
}
