# Product Requirements Document: Chorus

**Working name:** Chorus  
**One-line pitch:** Upload a long-form podcast or video and give an AI content team a growth objective. The system decides what content should be created, produces it, critiques its own work, and delivers a coherent multi-platform content campaign.

## 1. Product Overview

Chorus is an agentic content repurposing platform for creators, podcasters, founders, and small marketing teams.

Instead of following a fixed pipeline such as:

Podcast → transcript → clips → captions → posts

Chorus receives a higher-level objective such as:

> Grow my audience among junior software engineers using this podcast.

The system analyzes the source material, determines which ideas are worth distributing, creates a content strategy, allocates work across specialized agents, generates content, evaluates its own outputs, revises weak assets, and produces a final campaign.

The primary product experience should feel like assigning work to a small autonomous content team rather than operating an editing tool.

---

# 2. Problem

Long-form content contains significantly more reusable material than creators have time to extract.

A two-hour podcast may contain:

- strong opinions
- educational explanations
- stories
- funny moments
- controversial statements
- memorable quotes
- useful frameworks
- short-form hooks
- multiple independent topics

Existing repurposing tools commonly optimize around a fixed task:

- automatically cut clips
- generate subtitles
- summarize the episode
- create social posts
- generate show notes

The creator still needs to decide:

- What should I actually post?
- Which audience should each idea target?
- Which clips are worth using?
- Which ideas are repetitive?
- Which platform fits each idea?
- Is the hook strong enough?
- Does the clip make sense without context?
- Are five generated posts all saying the same thing?
- Which content should be rejected entirely?

Chorus moves those decisions into an agentic planning and review layer.

---

# 3. Target User

## Primary user

A creator, founder, podcaster, or small team producing long-form video or audio.

Typical characteristics:

- produces 30–180 minute content
- posts on multiple social platforms
- does not have a dedicated content team
- wants to turn one recording into multiple useful assets
- cares more about quality than generating the maximum number of posts

## MVP persona

Solo technical creator.

Example:

> I recorded a 90-minute podcast about software careers and AI. I want to grow an audience of junior developers on TikTok, X, and LinkedIn.

---

# 4. Product Goal

Given one long-form media file and a campaign objective, autonomously create the strongest possible multi-platform content package.

The system should decide:

1. What the source content is about.
2. Which ideas are strongest.
3. Which ideas should not be used.
4. Which platforms suit each idea.
5. Which content formats should be created.
6. How many assets should be generated.
7. Whether generated assets meet quality standards.
8. Whether assets overlap too heavily.
9. Whether revisions are required.
10. When the campaign is good enough to finish.

---

# 5. Product Principles

## 5.1 Goal-driven, not pipeline-driven

The user provides an objective.

The system determines the execution plan.

Bad:

> Every podcast creates exactly five clips, one LinkedIn post, and one X thread.

Good:

> This podcast contains two exceptional stories, one educational segment, and several weak sections. Produce two clips, one thread, and one LinkedIn post.

---

## 5.2 Agents may reject work

The system must be able to decide:

> This segment is not good enough to publish.

Generation should not imply acceptance.

---

## 5.3 Campaign quality matters more than individual asset quality

Five excellent posts about the exact same idea create a poor campaign.

Chorus should evaluate the campaign as a portfolio.

---

## 5.4 Agents must have distinct responsibilities

Agents should not exist merely to make the architecture appear multi-agent.

Each agent must differ in at least one of:

- objective
- context
- permissions
- tools
- evaluation criteria

---

## 5.5 Outputs must be observable

Users should understand:

- which agent is active
- what it decided
- why it made that decision
- what tools it used
- what failed
- what it revised

---

# 6. User Input

Required:

### Source

- MP4
- MOV
- MP3
- WAV

Video is the primary assumption.

Audio-only sources are accepted, but produce caption-card audiograms rather than talking-head clips, and skip visual inspection entirely.

Detection is by probing for a video stream, not by file extension.

### Campaign goal

Free-text input.

Example:

> Grow my audience among junior software engineers.

### Target platforms

MVP:

- TikTok / Reels / Shorts
- X
- LinkedIn

Optional user settings:

- audience
- brand voice
- maximum number of assets
- maximum total video duration
- clip length range
- desired content style

Example:

```text
Audience:
Junior software engineers

Voice:
Opinionated, useful, conversational

Platforms:
TikTok
X
LinkedIn

Maximum assets:
6

Maximum short-form video:
120 seconds
```

---

# 7. Core User Experience

## Step 1 — Create campaign

User uploads media and enters objective.

Example:

> Turn this podcast into content that helps me grow among software engineers.

User clicks:

**Build Campaign**

---

# 8. Agent Architecture

MVP agents:

1. Content Director
2. Source Analyst
3. Content Strategist
4. Clip Producer
5. Writing Agent
6. Content Critic
7. Campaign Reviewer

Optional later:

8. Research Agent
9. Analytics Agent
10. Brand Guardian
11. Publishing Agent

---

# 9. Agent Responsibilities

## 9.1 Content Director

The Content Director is the orchestration agent.

Responsibilities:

- understand user objective
- determine which agents should run
- allocate content budget
- approve or modify strategy
- react to failed agent outputs
- request revisions
- decide when campaign is complete

The Director should not create clips or posts directly.

### Example decision

```text
Objective:
Grow audience among junior engineers.

Available content:
- career story
- AI hot take
- system design tutorial
- interview advice

Strategy:
Prioritize personal career story and AI opinion.

Skip system-design tutorial because it overlaps with existing educational content and contains no strong hook.
```

---

# 10. Source Analyst Agent

Analyzes the entire recording.

Inputs:

- transcript
- timestamps
- speaker information where available
- visual frames where useful

Outputs structured segments.

Example:

```json
{
  "segment_id": "seg_104",
  "start": 1334,
  "end": 1382,
  "topic": "Amazon interview failure",
  "summary": "Speaker explains failing an Amazon interview despite over-preparing.",
  "content_type": "personal_story",
  "energy": 0.86,
  "standalone_score": 0.91,
  "novelty_score": 0.88,
  "potential_hooks": [
    "I spent three months preparing for Amazon and failed in 15 minutes."
  ]
}
```

The Source Analyst should identify:

- topic boundaries
- stories
- opinions
- advice
- educational explanations
- emotional peaks
- humor
- quotable statements
- potential hooks
- context dependencies

---

# 11. Content Strategist Agent

Receives:

- source analysis
- campaign goal
- audience
- platforms
- content budget

Produces a campaign plan.

Example:

```text
Campaign Strategy

Asset 1
Format: TikTok clip
Topic: Amazon interview failure
Purpose: Relatability / career content

Asset 2
Format: TikTok clip
Topic: Why junior developers misuse AI
Purpose: Strong opinion / reach

Asset 3
Format: LinkedIn post
Topic: What interview failure changed about preparation
Purpose: Personal professional story

Asset 4
Format: X thread
Topic: Five mistakes junior engineers make with AI
Purpose: Educational shareability

Skipped:
System design explanation

Reason:
Strong educational value but weak differentiation and low emotional energy.
```

Strategy output must include reasoning.

---

# 12. Content Budget

The Content Director receives limited resources.

Example:

```text
Generation budget:
12 generation credits

Max assets:
6

Max video:
120 seconds
```

Possible costs:

```text
Generate clip: 3 credits
Generate thread: 2
Generate LinkedIn post: 2
Generate carousel: 3
Regenerate asset: 1
```

This introduces planning constraints.

The agent must choose between alternatives.

Example:

> Producing six short clips would exceed the content diversity target. I will produce three clips and two written assets instead.

---

# 13. Clip Producer Agent

Responsibilities:

- choose exact timestamp boundaries
- extract video using FFmpeg
- ensure the hook occurs quickly
- remove unnecessary context
- create subtitles
- optionally crop 16:9 → 9:16
- generate title / hook text

For audio-only sources, the crop and visual inspection steps are skipped.

Boundary selection, pacing evaluation, and subtitle generation are unchanged, since they derive from silence detection and word timings rather than from frames.

Important:

The agent must interact iteratively with generated video.

Process:

```text
Select segment
↓
Cut video
↓
Analyze resulting clip
↓
Evaluate pacing
↓
Adjust start/end
↓
Render
```

Clip selection must not simply use semantic similarity.

Evaluation criteria:

- hook strength
- standalone comprehensibility
- payoff
- emotional energy
- originality
- duration
- dead time

---

# 14. Writing Agent

Produces:

- X posts
- X threads
- LinkedIn posts
- captions
- hooks

Receives:

- specific source evidence
- campaign strategy
- brand voice

Must not invent claims not present in the source.

---

# 15. Content Critic Agent

Evaluates every generated asset independently.

Each asset receives structured scores.

Example:

```json
{
  "hook": 8,
  "clarity": 9,
  "standalone": 7,
  "originality": 8,
  "audience_fit": 9,
  "payoff": 8,
  "status": "REVISE",
  "feedback": "The strongest statement occurs 9 seconds into the clip. Shorten the introduction."
}
```

Possible outcomes:

- PASS
- REVISE
- REJECT

A REVISE result returns actionable feedback to the producing agent.

A REJECT result allows the Strategist to choose another idea.

---

# 16. Campaign Reviewer Agent

After individual assets pass review, evaluate them collectively.

Responsibilities:

- detect duplicate ideas
- detect repetitive hooks
- check brand consistency
- check audience coverage
- check platform fit
- evaluate campaign diversity

Example:

```text
Campaign Review

Asset quality: 89/100
Diversity: 47/100

Problem:
3 of 5 assets communicate the same argument about AI replacing developers.

Recommendation:

Keep TikTok #1.

Replace LinkedIn article with:
"How AI changed the way I learn software engineering."

Replace X thread with:
"Five mistakes junior developers make when using AI."
```

This creates a global feedback loop.

---

# 17. Agentic Workflow

The workflow should NOT be hard-coded as:

```text
Analyze
→ Strategy
→ Generate all
→ Done
```

Instead:

```text
User Goal
    ↓
Director
    ↓
Analyze source
    ↓
Plan campaign
    ↓
Director evaluates plan
    ↓
Assign asset creation
    ↓
Critic reviews each asset
    ↓
 ┌─────────────┐
 │ PASS?       │
 └──────┬──────┘
        │
   No ──┴── Yes
   ↓          ↓
Revise     Campaign Review
   ↓          ↓
re-review   Diverse?
              │
          No ─┴─ Yes
          ↓       ↓
        Replan   Finish
```

---

# 18. Human Approval

MVP should include at least one approval gate.

Before finalization:

```text
Campaign ready.

5 assets approved.

[Approve Campaign]
[Request Changes]
```

Optional:

Allow users to approve strategy before expensive generation begins.

---

# 19. Dashboard

Main campaign page:

```text
AI CONTENT TEAM

Source Analyst
✓ Complete

Content Strategist
✓ Campaign planned

Clip Producer
● Rendering Clip #2

Writing Agent
✓ LinkedIn
✓ X Thread

Critic
● Reviewing

Campaign Reviewer
○ Waiting
```

Each agent should expose a collapsible activity log.

Example:

```text
CLIP PRODUCER

→ selected segment 22:14–22:58
→ rendered draft
→ detected 7.8 sec weak introduction
→ adjusted start to 22:22
→ rendered revision
```

---

# 20. Final Campaign UI

Display:

## Strategy

- campaign objective
- selected topics
- skipped topics
- strategy rationale

## Video Content

Preview cards.

Each contains:

- video player
- hook
- caption
- quality score
- source timestamp

## Written Content

Platform-specific preview.

## Campaign Review

```text
Overall score: 91/100

Content diversity: 88
Audience fit: 94
Brand consistency: 90
```

---

# 21. MVP Scope

MVP must support:

- one uploaded video/audio file
- transcription
- timestamp segmentation
- campaign objective
- audience
- TikTok/Short video
- LinkedIn post
- X thread
- strategy generation
- autonomous format selection
- clip extraction
- subtitle generation
- individual asset criticism
- revise/retry loop
- campaign-level duplication review
- agent activity timeline
- downloadable final assets

---

# 22. Explicit MVP Non-Goals

Do NOT build initially:

- direct TikTok publishing
- Instagram API
- YouTube publishing
- real social analytics
- scheduling
- team accounts
- payment system
- mobile app
- advanced video transitions
- fully automatic B-roll
- voice cloning
- image generation
- 20 social platforms

These distract from the agent system.

---

# 23. Suggested Technology

Frontend:

- Next.js
- React
- Tailwind
- shadcn/ui

Backend:

- Next.js server or FastAPI
- PostgreSQL / Supabase

Long-running jobs:

- Trigger.dev, Inngest, Temporal, or custom worker

Media:

- FFmpeg
- Whisper / transcription API
- multimodal model for clip review

Storage:

- S3 / Supabase Storage

Agent orchestration:

- custom state machine OR
- LangGraph

Recommendation:

Use an explicit graph/state-machine architecture rather than five independent chat loops.

---

# 24. Core Data Models

## Campaign

```text
id
source_media
goal
audience
brand_voice
platforms
status
created_at
```

## Segment

```text
id
campaign_id
start_time
end_time
transcript
topic
type
energy_score
standalone_score
novelty_score
```

## Strategy

```text
campaign_id
rationale
selected_topics
rejected_topics
planned_assets
```

## Asset

```text
id
campaign_id
type
platform
source_segments
content
media_url
status
revision_count
```

## Review

```text
asset_id
reviewer_agent
scores
feedback
decision
```

## AgentRun

```text
id
campaign_id
agent
input
output
tool_calls
status
duration
```

---

# 25. Agent Tool Interfaces

Example tools:

```text
getTranscript()
getSegments()
readSegment()
extractVideo(start, end)
renderVerticalVideo()
generateSubtitles()
inspectRenderedVideo()
createAsset()
updateAsset()
requestReview()
getCampaignAssets()
```

Agents should interact through these tools rather than directly accessing the database.

---

# 26. Guardrails

Maximum:

- 3 revisions per asset
- 2 full campaign replans
- 6 final assets for MVP
- configurable token/cost budget

If an asset repeatedly fails:

```text
Clip #3 failed review three times.

Director decision:
Abandon clip and select alternative segment.
```

This is preferable to infinite retries.

---

# 27. Success Metrics

For MVP:

### Functional

- ≥90% of agent runs finish without manual repair
- rendered clips correspond to selected timestamps
- no written asset contains unsupported factual claims
- rejected assets are not included in final package

### Agentic

A successful system should demonstrate:

- autonomous format selection
- autonomous topic rejection
- branching
- retry/revision
- cross-asset reasoning
- tool usage
- constrained planning

### Portfolio success

A viewer should understand the product within 10 seconds.

---

# 28. Ideal Demo

Opening screen:

```text
Podcast: 1h 43m

Goal:
Grow my audience among junior software engineers.

Platforms:
TikTok
X
LinkedIn

[Build Campaign]
```

Then show:

```text
Source Analyst
Found 14 candidate topics.
```

Then:

```text
Strategist
Selected 4.
Rejected 10.
```

Then:

```text
Critic
Rejected Clip #1:
Hook too slow.
```

Clip Producer retries.

Then:

```text
Campaign Reviewer
Detected repetitive AI messaging.
Replacing LinkedIn post.
```

Finally:

```text
CAMPAIGN COMPLETE

2 short videos
1 X thread
1 LinkedIn post
```

Play the generated short clip.

This demo clearly communicates that the product is not merely a linear content pipeline.

---

# 29. Future Versions

## V2 — Performance Learning

Connect social analytics.

Store:

```text
Asset
Topic
Hook type
Format
Views
Watch time
Retention
Engagement
```

Analytics Agent learns:

> Personal career stories outperform generic tutorials for this creator.

Future campaigns incorporate that history.

---

## V3 — Autonomous publishing

Agent decides:

- platform
- publication order
- schedule

Human approval remains available.

---

## V4 — Full content organization

Multiple source files.

Agent can reason across:

- podcasts
- streams
- previous clips
- drafts
- existing posts

The system becomes persistent content memory for a creator.

---

# 30. Product Definition of Done

Chorus MVP is complete when a user can:

1. Upload a long-form recording.
2. Specify a growth objective.
3. Watch the AI team analyze it.
4. Receive an autonomous content strategy.
5. See agents create multiple content formats.
6. Observe at least one review/revision loop.
7. See the Campaign Reviewer evaluate the package globally.
8. Download a coherent final campaign.

The user should feel:

> I gave this AI team an objective and source material. It decided what was worth making and produced the campaign for me.