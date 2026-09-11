# Phone listening device checklist

Run these checks on the TestFlight build identified in the release evidence. Simulator acceptance verifies the state and transport behaviour; these checks verify physical audio routing, background capture and APNs delivery.

1. On Home, tap Start listening. Lock the phone. After 10 minutes the orange microphone indicator is still shown on the lock screen. Say "Zeca, create a test task called phone listening". A short tone plays within a second and the card appears in the Kanban Loop.
2. Receive or place a phone call and end it. Within a few seconds Home shows Listening again and no push arrived.
3. In another app, dictate a sentence with Wispr Flow. After dictation Home shows Listening again.
4. Play a podcast. The podcast keeps playing at normal volume and the transcript on the capture screen keeps flowing.
5. Connect AirPods and play music. Music quality is unchanged, the transcript keeps flowing from the phone microphone.
6. Force quit Garrison from the app switcher. Within about 30 seconds a push arrives with the title "Zeca stopped listening". Tap it. The app opens on the capture screen already Listening, with no further tap.
7. Hold the stop button until the ring completes. Home shows Not listening, the badge disappears, and no push arrives afterwards.

For each step record pass or fail, build number, node, time and any unexpected state or audio behaviour. The server's last frame or heartbeat and the app's engine report are the listening truth. The orange indicator in step 1 is an additional physical observation.
