# Demo recording for the README — https://github.com/charmbracelet/vhs
#   brew install vhs
#   cd <an empty folder> && vhs <plugin>/docs/demo.tape
# Produces assets/demo.gif (move it into the plugin repo's assets/ and uncomment the slot in README.md).
# Tip: run it once on a prepared workspace (ICP approved, a few accounts researched) so the demo is quick;
# Claude's responses vary, so adjust the Sleep durations after a dry run.

Output demo.gif
Set Shell "zsh"
Set FontSize 15
Set Width 1400
Set Height 800
Set Theme "GitHub Dark"
Set TypingSpeed 45ms
Set Padding 24

Type "claude"
Enter
Sleep 4s

Type "/agentic-sales-engine:status"
Enter
Sleep 20s

Type "/agentic-sales-engine:score --explain maasverhoeven.example"
Enter
Sleep 35s

Type "/agentic-sales-engine:draft-outreach --icp ap-automation-midmarket maasverhoeven.example"
Enter
Sleep 60s

Ctrl+C
Sleep 1s
