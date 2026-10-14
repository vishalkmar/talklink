// FAQ (Phase 33.9). Served by GET /content/faq so answers change with a server deploy, no app
// release. Numbers that come from .env are filled in by content.routes.js ({placeholders}).
const FAQ = [
  {
    id: 'what',
    q: 'What is {appName}?',
    a: 'A place to talk to new people by voice or text. Tap Start talking to be matched with someone who is online, or call a friend with their private number.',
  },
  {
    id: 'private_number',
    q: 'What is my private number?',
    a: 'A short number that is only yours. Share it with people you want to call you - they can search it from Profile > Search by private number. Your email is never shown to anyone.',
  },
  {
    id: 'who_can_call',
    q: 'Can I stop people from calling me?',
    a: 'Yes. Go to Profile > Who can call me and choose Everyone, People I talked to, or Nobody. You can also block anyone from their profile.',
  },
  {
    id: 'credits',
    q: 'How do I get credits?',
    a: 'Watch short videos, spin the wheel, finish daily goals, collect the daily bonus, or invite friends ({referralBonus} credits each). You can also buy credit packs.',
  },
  {
    id: 'gender_filter',
    q: 'How does the gender filter work?',
    a: 'Unlocking it costs {genderFilterCost} credits and lasts {genderFilterPassMin} minutes. If no one is found before your first match, the credits come back. Premium members use it free.',
  },
  {
    id: 'streak',
    q: 'How do streaks work?',
    a: 'Have at least one call or chat of 1 minute every day (India time) and your streak goes up. Miss a day and it starts again - but once a week you can watch a video to bring it back.',
  },
  {
    id: 'aura',
    q: 'What is aura?',
    a: 'Points that show how good your conversations are. You get aura for time spent talking, good ratings from others and finished goals. The top aura of the week is on the Goals tab.',
  },
  {
    id: 'report',
    q: 'Someone was rude. What do I do?',
    a: 'Open their profile (or the menu during a call) and tap Report. They are blocked for you right away and our team reviews the report.',
  },
  {
    id: 'premium',
    q: 'What does Premium give me?',
    a: 'Free gender filter, more spins without videos, a premium badge and faster matching. Premium is not a subscription - it simply ends after the time you bought.',
  },
  {
    id: 'not_ringing',
    q: "I don't get calls when the app is closed",
    a: 'Allow notifications for {appName}, turn on "Incoming calls" in Profile > Notifications, and turn off battery saving for the app in your phone settings.',
  },
  {
    id: 'delete',
    q: 'How do I delete my account?',
    a: 'Profile > Delete account. We send a code to your email to confirm. Your profile is removed right away and cannot be brought back.',
  },
];

module.exports = { FAQ };
