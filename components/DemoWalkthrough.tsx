'use client';

import { useEffect, useMemo, useState } from 'react';
import { CampaignWorkspace } from '@/components/CampaignMonitor';
import { Button } from '@/components/ui/button';
import { DEMO_CAMPAIGN_ID, DEMO_MOMENTS, DEMO_STEPS, demoStream } from '@/lib/demo-campaign';

export function DemoWalkthrough() {
  const [momentIndex, setMomentIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [run, setRun] = useState(0);
  const stream = useMemo(() => demoStream(momentIndex), [momentIndex]);
  const moment = DEMO_MOMENTS[momentIndex];
  const phase = DEMO_STEPS[moment.phase];
  const waitingForApproval = moment.gate !== null;
  const complete = momentIndex === DEMO_MOMENTS.length - 1;

  useEffect(() => {
    if (!playing || moment.delayMs === null) return;

    const timeout = window.setTimeout(() => {
      setMomentIndex((current) => current === momentIndex ? current + 1 : current);
    }, moment.delayMs);

    return () => window.clearTimeout(timeout);
  }, [moment.delayMs, momentIndex, playing, run]);

  function restart() {
    setMomentIndex(0);
    setPlaying(true);
    setRun((value) => value + 1);
  }

  const controls = (
    <div className="demo-walkthrough-controls" aria-label="Demo walkthrough controls">
      <div className="hidden min-w-0 lg:block">
        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.13em]">
          <span className={waitingForApproval ? 'chorus-state-dot chorus-state-dot-gate' : 'chorus-state-dot chorus-state-dot-active'} />
          <span className={waitingForApproval ? 'text-state-gate' : 'text-state-active'}>
            {waitingForApproval ? 'Your decision' : complete ? 'Walkthrough complete' : playing ? 'Auto playing' : 'Paused'}
          </span>
        </p>
        <p className="mt-1 max-w-72 truncate text-[13px] font-medium" aria-live="polite">
          {phase.label}: {moment.label}
        </p>
      </div>
      <div className="demo-auto-steps" aria-label={`${phase.label}, phase ${moment.phase + 1} of ${DEMO_STEPS.length}`}>
        {DEMO_STEPS.map((item, index) => (
          <span
            key={item.label}
            className={index < moment.phase ? 'demo-auto-step demo-auto-step--complete' : index === moment.phase ? 'demo-auto-step demo-auto-step--active' : 'demo-auto-step'}
            title={item.label}
          />
        ))}
      </div>
      <span className="text-muted-foreground hidden text-[11px] font-medium xl:inline">
        {moment.phase + 1} of {DEMO_STEPS.length}
      </span>
      {!complete && (
        <Button type="button" size="sm" variant="outline" onClick={() => setPlaying((value) => !value)} aria-pressed={!playing}>
          {playing ? 'Pause' : 'Resume'}
        </Button>
      )}
      <Button type="button" size="sm" variant="outline" onClick={restart}>Restart</Button>
    </div>
  );

  return (
    <CampaignWorkspace
      key={run}
      campaignId={DEMO_CAMPAIGN_ID}
      stream={stream}
      demoControls={controls}
      onApprovalAction={(action) => {
        if (action === 'approve') {
          setMomentIndex((value) => Math.min(DEMO_MOMENTS.length - 1, value + 1));
        }
        if (action === 'request_changes') {
          setMomentIndex((value) => {
            const target = DEMO_MOMENTS[value].gate === 'strategy' ? 'strategize' : 'replan';
            return DEMO_MOMENTS.findIndex((candidate) => candidate.currentNode === target);
          });
          setRun((value) => value + 1);
        }
      }}
    />
  );
}
