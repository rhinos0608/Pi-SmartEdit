import re

with open('src/verification/change-targets.ts', 'r') as f:
    content = f.read()

# Fix the corrupted line
old = 'path.split("\\\\"")'
new = 'path.split("\\\\")'
content = content.replace(old, new)

with open('src/verification/change-targets.ts', 'w') as f:
    f.write(content)

print("Fixed")
