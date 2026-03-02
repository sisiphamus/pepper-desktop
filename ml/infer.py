"""
Persistent inference subprocess for Phase A (classifier) and Phase B (TF-IDF retrieval).
Reads newline-delimited JSON from stdin, writes newline-delimited JSON to stdout.

Protocol:
  Phase A:  { "task": "phase_a", "prompt": "..." }
  Phase B:  { "task": "phase_b", "prompt": "...", "inventory": [{name, category, description, path}, ...] }
"""

import sys
import json
import pickle
import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Threshold for Phase A label activation.
# A label is "on" if its predicted probability exceeds this value.
# If nothing exceeds it, we fall back to the highest-probability label.
# ---------------------------------------------------------------------------
THRESHOLD = 0.38

MODEL_PATH = Path(__file__).parent / 'models' / 'phase_a.pkl'
LABELS = ['text', 'picture', 'command', 'presentation', 'specificFile', 'other']

# ---------------------------------------------------------------------------
# Load Phase A model at startup
# ---------------------------------------------------------------------------
try:
    with open(MODEL_PATH, 'rb') as f:
        _model = pickle.load(f)
    _vec = _model['vectorizer']
    _clf = _model['classifier']
    _labels = _model.get('labels', LABELS)
except Exception as e:
    sys.stderr.write(f'[infer.py] Failed to load Phase A model: {e}\n')
    sys.stderr.flush()
    _vec = None
    _clf = None
    _labels = LABELS


# ---------------------------------------------------------------------------
# Phase A: multi-label output type classifier
# ---------------------------------------------------------------------------
def run_phase_a(prompt: str) -> dict:
    if _vec is None or _clf is None:
        # Fallback if model failed to load
        return _fallback_spec(prompt)

    X = _vec.transform([prompt])
    probas = _clf.predict_proba(X)  # list of arrays, one per label

    scores = {}
    for i, label in enumerate(_labels):
        scores[label] = float(probas[i][0][1])  # probability of class=1

    # Apply threshold; if nothing activates, take the argmax
    labels_on = {k: v >= THRESHOLD for k, v in scores.items()}
    if not any(labels_on.values()):
        best = max(scores, key=scores.get)
        labels_on[best] = True

    # Derive the legacy outputType (first active label in priority order)
    priority = ['command', 'picture', 'presentation', 'specificFile', 'text', 'other']
    output_type = next((l for l in priority if labels_on.get(l)), 'text')

    return {
        'taskDescription': prompt[:500],
        'outputType': output_type,
        'outputLabels': labels_on,
        'outputScores': {k: round(v, 3) for k, v in scores.items()},
        'outputFormat': {
            'type': 'inline_text',
            'structure': 'direct answer',
            'deliveryMethod': 'inline',
        },
        'requiredDomains': [],
        'complexity': 'simple',
        'estimatedSteps': 1,
    }


def _fallback_spec(prompt: str) -> dict:
    return {
        'taskDescription': prompt[:500],
        'outputType': 'text',
        'outputLabels': {l: (l == 'text') for l in LABELS},
        'outputFormat': {'type': 'inline_text', 'structure': 'direct answer', 'deliveryMethod': 'inline'},
        'requiredDomains': [],
        'complexity': 'simple',
        'estimatedSteps': 1,
    }


# ---------------------------------------------------------------------------
# Phase B: TF-IDF cosine similarity file retrieval
# ---------------------------------------------------------------------------
def run_phase_b(prompt: str, inventory: list) -> dict:
    if not inventory:
        return {
            'selectedMemories': [],
            'missingMemories': [],
            'toolsNeeded': [],
            'notes': 'No memory files in inventory',
        }

    # Read file contents for each inventory item
    docs = []
    for item in inventory:
        path = item.get('path', '')
        try:
            with open(path, encoding='utf-8', errors='replace') as f:
                content = f.read()
        except Exception:
            content = item.get('description', '')
        docs.append({
            'name': item.get('name', ''),
            'category': item.get('category', 'knowledge'),
            'description': item.get('description', ''),
            'content': content,
        })

    # Build TF-IDF on the corpus (memory file contents) + query
    corpus = [d['content'] for d in docs]
    scores = _tfidf_cosine(prompt, corpus)

    # Sort and filter
    THRESHOLD_B = 0.02
    MAX_FILES = 8

    ranked = sorted(zip(scores, docs), key=lambda x: x[0], reverse=True)
    selected = []
    for score, doc in ranked:
        if score > THRESHOLD_B and len(selected) < MAX_FILES:
            selected.append({
                'name': doc['name'],
                'category': doc['category'],
                'reason': f'similarity: {score:.2f}',
            })

    return {
        'selectedMemories': selected,
        'missingMemories': [],
        'toolsNeeded': [],
        'notes': f'Selected by TF-IDF cosine similarity from {len(docs)} memory files (threshold {THRESHOLD_B}, top {MAX_FILES})',
    }


def _tfidf_cosine(query: str, docs: list) -> list:
    """
    Compute TF-IDF cosine similarity between query and each doc.
    Uses sklearn if available (fast), falls back to pure-Python implementation.
    """
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        import numpy as np
        corpus = [query] + docs
        vec = TfidfVectorizer(ngram_range=(1, 2), max_features=3000, sublinear_tf=True)
        X = vec.fit_transform(corpus)
        query_vec = X[0]
        doc_vecs = X[1:]
        # Cosine similarity: dot(q, d) / (||q|| * ||d||)
        # Since TF-IDF rows are already L2-normalised by sklearn when norm='l2' (default)
        sims = (doc_vecs * query_vec.T).toarray().flatten()
        return sims.tolist()
    except Exception:
        return _tfidf_cosine_pure(query, docs)


def _tfidf_cosine_pure(query: str, docs: list) -> list:
    """Fallback: pure-Python TF-IDF cosine similarity."""
    import math
    from collections import Counter

    def tokenize(text):
        return text.lower().split()

    all_docs = [query] + docs
    token_lists = [tokenize(d) for d in all_docs]

    # IDF
    N = len(all_docs)
    df = Counter()
    for tokens in token_lists:
        for t in set(tokens):
            df[t] += 1
    idf = {t: math.log((N + 1) / (cnt + 1)) + 1 for t, cnt in df.items()}

    def tfidf_vec(tokens):
        tf = Counter(tokens)
        total = len(tokens) or 1
        return {t: (cnt / total) * idf.get(t, 0) for t, cnt in tf.items()}

    def cosine(v1, v2):
        dot = sum(v1.get(t, 0) * v2.get(t, 0) for t in v1)
        n1 = math.sqrt(sum(x * x for x in v1.values()))
        n2 = math.sqrt(sum(x * x for x in v2.values()))
        if n1 == 0 or n2 == 0:
            return 0.0
        return dot / (n1 * n2)

    query_vec = tfidf_vec(token_lists[0])
    return [cosine(query_vec, tfidf_vec(tokens)) for tokens in token_lists[1:]]


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main():
    sys.stderr.write('[infer.py] Ready\n')
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            task = req.get('task')
            if task == 'phase_a':
                result = run_phase_a(req.get('prompt', ''))
            elif task == 'phase_b':
                result = run_phase_b(req.get('prompt', ''), req.get('inventory', []))
            else:
                result = {'error': f'unknown task: {task}'}
        except Exception as e:
            result = {'error': str(e)}

        sys.stdout.write(json.dumps(result) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
