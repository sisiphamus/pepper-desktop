"""
Phase A multi-label output-type classifier.
Generates synthetic training data, trains, evaluates, and saves the model.

Labels (independent binary):
  text, picture, command, presentation, specificFile, other
"""

import pickle, random, os
from pathlib import Path
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.multioutput import MultiOutputClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import cross_val_score
import numpy as np

LABELS = ['text', 'picture', 'command', 'presentation', 'specificFile', 'other']

TOPICS = [
    "machine learning", "Python", "climate change", "the Roman Empire",
    "quantum computing", "the stock market", "photosynthesis", "blockchain",
    "the French Revolution", "deep learning", "solar energy", "DNA replication",
    "the Cold War", "React hooks", "electric vehicles", "antibiotics",
    "supply chain management", "the Renaissance", "neural networks", "Docker",
    "inflation", "the Amazon rainforest", "TypeScript", "space exploration",
    "the human brain", "cryptocurrency", "agile methodology", "gene therapy",
    "the Silk Road", "cloud computing",
]
APPS = [
    "Chrome", "Spotify", "VS Code", "Slack", "Notepad", "Discord",
    "Excel", "Terminal", "Word", "Telegram", "Outlook", "Firefox",
    "Calculator", "Paint", "Task Manager", "Zoom",
]
FILENAMES = [
    "report.pdf", "notes.txt", "script.py", "config.json", "data.csv",
    "presentation.pptx", "diagram.png", "README.md", "output.xlsx",
]
NAMES = ["John", "Sarah", "the team", "my manager", "the client"]


# ---------------------------------------------------------------------------
# Seed templates per label
# ---------------------------------------------------------------------------

SEEDS = {
    "text": [
        "explain {topic}",
        "what is {topic}",
        "summarize {topic} for me",
        "give me an overview of {topic}",
        "describe how {topic} works",
        "compare {topic} and quantum computing",
        "tell me about {topic}",
        "define {topic}",
        "list the pros and cons of {topic}",
        "why is {topic} important",
        "how does {topic} affect the economy",
        "write a paragraph about {topic}",
        "can you explain {topic} to a beginner",
        "what are the key concepts in {topic}",
        "what should I know about {topic}",
        "give me 5 facts about {topic}",
        "what are the main arguments for {topic}",
        "break down {topic} into simple terms",
        "what's the history of {topic}",
        "how is {topic} different from machine learning",
        "is {topic} related to React hooks",
        "help me understand {topic}",
        "I want to learn about {topic}",
        "what do experts say about {topic}",
    ],
    "picture": [
        "draw me a picture of {topic}",
        "generate an image of {topic}",
        "create a diagram of {topic}",
        "make a chart showing {topic}",
        "visualize {topic} for me",
        "sketch a concept for {topic}",
        "illustrate how {topic} works",
        "produce a photo of {topic}",
        "show me what {topic} looks like",
        "design a logo for {topic}",
        "make an infographic about {topic}",
        "create a visual representation of {topic}",
        "draw a flowchart for {topic}",
        "I want a picture of {topic}",
        "generate artwork depicting {topic}",
        "make a banner image for {topic}",
        "create a thumbnail for {topic}",
        "visualize the process of {topic}",
        "draw a mind map for {topic}",
        "generate a graph showing {topic}",
    ],
    "command": [
        "open {app}",
        "launch {app}",
        "close {app}",
        "restart {app}",
        "install {app}",
        "run {app}",
        "start {app}",
        "connect my Bluetooth speaker",
        "turn off the Wi-Fi",
        "click on the submit button",
        "type my email into the search box",
        "move the mouse to the top right",
        "press enter",
        "execute this shell command",
        "set up my environment",
        "start the server",
        "kill the process",
        "check the disk usage",
        "set a system reminder for 3pm",
        "open a new terminal",
        "navigate to the downloads folder",
        "right-click on the desktop",
        "scroll down on the page",
        "copy the selected text",
        "paste into {app}",
        "switch to the next window",
        "minimize {app}",
        "check my CPU usage",
    ],
    "presentation": [
        "create a presentation about {topic}",
        "make slides on {topic}",
        "build a slide deck for {topic}",
        "prepare a PowerPoint about {topic}",
        "make a slideshow about {topic}",
        "I need a deck on {topic} for {name}",
        "create a 10-slide presentation on {topic}",
        "build me a pitch deck about {topic}",
        "make presentation slides covering {topic}",
        "put together a deck on {topic}",
        "create an executive presentation on {topic}",
        "make a keynote about {topic}",
        "design slides for a talk on {topic}",
        "prepare a briefing deck on {topic}",
        "I have a meeting about {topic}, make slides",
        "create a workshop presentation on {topic}",
    ],
    "specificFile": [
        "create a file called {filename}",
        "write a Python script for {topic}",
        "save this as {filename}",
        "generate a PDF report on {topic}",
        "export this to {filename}",
        "create a config file for {topic}",
        "write a .py script that handles {topic}",
        "produce a document I can download about {topic}",
        "make a CSV with data about {topic}",
        "generate a JSON file for {topic}",
        "create a markdown file about {topic}",
        "write a shell script to automate {topic}",
        "save the results to {filename}",
        "create an Excel spreadsheet for {topic}",
        "generate a text file with notes on {topic}",
        "write a README for the {topic} project",
        "create a requirements.txt for {topic}",
        "make a backup of {filename}",
        "output the results as {filename}",
        "generate a log file for {topic}",
    ],
    "other": [
        "tell me a joke",
        "what do you think about life",
        "I'm bored",
        "let's just chat",
        "what's your favourite colour",
        "play a word game with me",
        "I don't know what I need",
        "just do something interesting",
        "surprise me",
        "what's the meaning of life",
        "I want to talk to someone",
        "are you sentient",
        "what can you do",
        "how are you feeling today",
        "let's have a conversation",
        "say something random",
        "make me laugh",
        "I'm feeling lonely",
        "what's the weather like",
        "do you dream",
        "who would win in a fight",
        "what's your opinion on cats",
        "recommend me a movie",
        "what music do you like",
        "tell me something I don't know",
        "what would you do if you were human",
        "just checking in",
        "are you there",
        "ping",
        "nothing just testing",
        "hi",
        "hey",
        "hello",
        "good morning",
        "what's up",
        "how's it going",
        "thanks",
        "ok",
        "cool",
        "nice",
        "interesting thought: {topic}",
    ],
}

# Multi-label examples: (text, label_dict)
MULTI_LABEL_SEEDS = [
    # command + specificFile
    ("run a Python script that saves the output to {filename}", {"command": 1, "specificFile": 1}),
    ("execute the script and write results to {filename}", {"command": 1, "specificFile": 1}),
    ("install the package and create a config file {filename}", {"command": 1, "specificFile": 1}),
    # command + picture
    ("open Paint and draw {topic}", {"command": 1, "picture": 1}),
    ("take a screenshot of {app}", {"command": 1, "picture": 1}),
    ("run the script and generate a graph of {topic}", {"command": 1, "picture": 1}),
    # text + specificFile
    ("write a report on {topic} and save it as {filename}", {"text": 1, "specificFile": 1}),
    ("summarize {topic} and export as {filename}", {"text": 1, "specificFile": 1}),
    ("research {topic} and save notes to {filename}", {"text": 1, "specificFile": 1}),
    # picture + specificFile
    ("generate an image of {topic} and save it as {filename}", {"picture": 1, "specificFile": 1}),
    ("create a diagram and export as {filename}", {"picture": 1, "specificFile": 1}),
    # presentation + specificFile
    ("build a presentation on {topic} and save as {filename}", {"presentation": 1, "specificFile": 1}),
    ("make slides about {topic} and export them", {"presentation": 1, "specificFile": 1}),
    # text + picture
    ("explain {topic} with a diagram", {"text": 1, "picture": 1}),
    ("describe {topic} and include a chart", {"text": 1, "picture": 1}),
    # command + text
    ("check the logs and summarize what happened with {topic}", {"command": 1, "text": 1}),
    ("run a health check and give me a status report", {"command": 1, "text": 1}),
]


def fill(template):
    t = template
    if '{topic}' in t:
        t = t.replace('{topic}', random.choice(TOPICS))
    if '{app}' in t:
        t = t.replace('{app}', random.choice(APPS))
    if '{filename}' in t:
        t = t.replace('{filename}', random.choice(FILENAMES))
    if '{name}' in t:
        t = t.replace('{name}', random.choice(NAMES))
    return t


def generate_examples():
    texts = []
    y = []

    # Single-label examples
    for label_idx, label in enumerate(LABELS):
        seeds = SEEDS[label]
        label_vec = [0] * len(LABELS)
        label_vec[label_idx] = 1

        generated = set()
        for seed in seeds:
            # Each seed gets ~15 fillers
            for _ in range(15):
                text = fill(seed).strip()
                if text not in generated:
                    generated.add(text)
                    texts.append(text)
                    y.append(list(label_vec))

    # Multi-label examples
    for template, label_dict in MULTI_LABEL_SEEDS:
        label_vec = [label_dict.get(l, 0) for l in LABELS]
        for _ in range(12):
            text = fill(template).strip()
            texts.append(text)
            y.append(list(label_vec))

    return texts, y


def main():
    random.seed(42)
    print("Generating synthetic training data...")
    texts, y = generate_examples()
    y_arr = np.array(y)

    print(f"Total examples: {len(texts)}")
    for i, label in enumerate(LABELS):
        count = y_arr[:, i].sum()
        print(f"  {label}: {int(count)} positive examples")

    print("\nTraining TF-IDF + MultiOutputClassifier...")
    vectorizer = TfidfVectorizer(ngram_range=(1, 2), max_features=5000, sublinear_tf=True)
    X = vectorizer.fit_transform(texts)

    clf = MultiOutputClassifier(LogisticRegression(max_iter=1000, C=1.0, random_state=42))
    clf.fit(X, y_arr)

    print("\nCross-validation F1 per label (5-fold):")
    for i, label in enumerate(LABELS):
        scores = cross_val_score(
            LogisticRegression(max_iter=1000, C=1.0, random_state=42),
            X, y_arr[:, i], cv=5, scoring='f1'
        )
        print(f"  {label}: {scores.mean():.3f} ± {scores.std():.3f}")

    model = {'vectorizer': vectorizer, 'classifier': clf, 'labels': LABELS}
    out_path = Path(__file__).parent / 'models' / 'phase_a.pkl'
    out_path.parent.mkdir(exist_ok=True)
    with open(out_path, 'wb') as f:
        pickle.dump(model, f)
    print(f"\nModel saved to {out_path}")

    # Quick smoke test
    test_cases = [
        ("explain machine learning", ["text"]),
        ("draw me a cat", ["picture"]),
        ("open Chrome", ["command"]),
        ("create a presentation about React", ["presentation"]),
        ("write a Python script and save as script.py", ["command", "specificFile"]),
        ("tell me a joke", ["other"]),
    ]
    print("\nSmoke tests:")
    for prompt, expected in test_cases:
        X_test = vectorizer.transform([prompt])
        preds = clf.predict(X_test)[0]
        predicted = [LABELS[i] for i, v in enumerate(preds) if v]
        ok = "OK" if any(e in predicted for e in expected) else "FAIL"
        print(f"  [{ok}] '{prompt}' -> {predicted} (expected: {expected})")


if __name__ == '__main__':
    main()
