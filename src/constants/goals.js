// Goals (Phase 32.8 / 32.9 / 32.11). Progress is counted per IST day / ISO week by
// gamification.service; claiming pays the reward once.
//   metric: what counts
//     talk_seconds     - seconds of connected calls + text sessions
//     connections      - calls / text sessions with someone (>= STREAK_MIN_SECONDS)
//     spins            - spin-wheel spins
//     messages         - chat messages sent
//   target: in the metric's unit (talk: seconds; the app shows minutes)
const DAILY_GOALS = [
  {
    id: 'talk_10',
    metric: 'talk_seconds',
    target: 10 * 60,
    title: 'Talk for 10 minutes',
    reward: { credits: 50, aura: 5 },
  },
  {
    id: 'connect_3',
    metric: 'connections',
    target: 3,
    title: 'Make 3 new connections',
    reward: { credits: 50, aura: 5 },
  },
  {
    id: 'spin_1',
    metric: 'spins',
    target: 1,
    title: 'Spin the wheel once',
    reward: { credits: 20, aura: 2 },
  },
  {
    id: 'messages_20',
    metric: 'messages',
    target: 20,
    title: 'Send 20 messages',
    reward: { credits: 30, aura: 3 },
  },
];

const WEEKLY_GOALS = [
  {
    id: 'talk_60',
    metric: 'talk_seconds',
    target: 60 * 60,
    title: 'Talk for 1 hour this week',
    reward: { credits: 300, aura: 30 },
  },
  {
    id: 'connect_15',
    metric: 'connections',
    target: 15,
    title: 'Make 15 connections this week',
    reward: { credits: 250, aura: 25 },
  },
  {
    id: 'messages_150',
    metric: 'messages',
    target: 150,
    title: 'Send 150 messages this week',
    reward: { credits: 150, aura: 15 },
  },
];

// 32.17 streak milestones -> badge ids
const STREAK_BADGES = [
  { days: 7, id: 'streak_7', title: '7-day streak' },
  { days: 30, id: 'streak_30', title: '30-day streak' },
  { days: 100, id: 'streak_100', title: '100-day streak' },
  { days: 365, id: 'streak_365', title: '1-year streak' },
];

const METRICS = ['talk_seconds', 'connections', 'spins', 'messages'];

module.exports = { DAILY_GOALS, WEEKLY_GOALS, STREAK_BADGES, METRICS };
