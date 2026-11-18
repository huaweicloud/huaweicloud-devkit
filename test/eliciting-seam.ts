import type {
  ElicitFormRequest,
  ElicitOutcome,
  ElicitationSeam,
} from '../plugins/huaweicloud-core/src/approval-types.ts';

// The fake elicitation seam shared by the approval batteries: records every
// raised form so a test can prove NO form fired (the retry memo and the
// standing grant must be popup-free), and lets the capability flip at
// runtime (the capability-flip ladder shapes). An answer function may read
// the request it is answering.
export function elicitingSeam(
  answer: ElicitOutcome | ((request: ElicitFormRequest) => ElicitOutcome),
  capable: boolean | (() => boolean) = true,
): { seam: ElicitationSeam; requests: ElicitFormRequest[] } {
  const requests: ElicitFormRequest[] = [];
  return {
    requests,
    seam: {
      get capable(): boolean {
        return typeof capable === 'function' ? capable() : capable;
      },
      async prompt(request) {
        requests.push(request);
        return typeof answer === 'function' ? answer(request) : answer;
      },
    },
  };
}
