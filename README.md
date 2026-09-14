# Relay

Hey — thanks for taking a look at this. Quick bit of context, honestly:

> I've been putting together this little chat / inbox app in my spare time. I rushed it, and I'm
> pretty sure I didn't think a bunch of things through — a few bits don't behave right once you
> actually use it. On top of that I never got around to the features I wanted. I could really use
> a second pair of hands.

So, a few things, if you don't mind:

1. **Get it running** and have a play with it.
2. **Something's off.** A few things don't behave the way they should once there's real traffic.
   Track down what you can and fix it — and leave me a short note per fix on what was actually wrong.
3. **Build some features.** I didn't finish the fun part. The things I had in mind are written up in
   [`tasks/`](tasks/) — pick whichever appeal to you and build **as many as you like** (or your own
   idea). No need to do them all; do good work on the ones you take.
4. **Anything you'd just do differently — do it (or note it).** I rushed this, so the structure, the
   types, bits of plumbing that aren't there... some of it probably makes you wince. If you'd change
   something, improve what bugs you most, or drop a note in [`docs/`](docs/) on what you'd change and
   why. I won't be offended — I'd rather see how you think about it.

## Running it

```
cp .env.example .env
docker compose up --build
```

Then open <http://localhost:3000>. It seeds a couple of demo users and conversations on first boot.

## Ground rules

- **Work in your own copy.** Clone this repo, push it to a fresh repo of your own, and send us the
  link when you're done. Public is fine.
- **Leave your working *in* the repo.** Notes, plans, decisions, dead ends — whatever you scribbled
  while figuring it out, commit it. There's a [`docs/`](docs/) and a [`spec/`](spec/) folder for
  exactly that. We care as much about *how* you worked as the final result, so please don't tidy it
  away before you send it.
- **No hard time limit.** A few focused hours is already a solid showing; if you're enjoying it, go
  further.
- Use whatever tools and setup you normally work with.
- Send us **just the link to your repo**, plus a short note on what you changed and why — what was
  broken, what you fixed, what you built.

---

## What changed in this fork

All four tasks are built, the bugs are found and fixed (test-first), plus load testing,
autoscaling, and a live Grafana dashboard. **Start at [`docs/overview.md`](docs/overview.md)** —
it links every write-up and lists the verification commands. The original assessment/plan is in
[`spec/assessment.md`](spec/assessment.md).

Quick taste:

```bash
docker compose up --build          # app :3000 (alice/bob/carol, password "demo"), Grafana :3001
docker compose exec api npm test   # 20 tests
./tools/load-test.sh               # isolated load test + autoscaler, live dashboard on :3101
```
