"""Train walwuk's optional ordering-only candidate policy.

The exported model is deterministic Q10 int16 data. It never removes a move and is
not included in production until paired-game promotion gates pass.
"""

from __future__ import annotations

import argparse
import json
import struct
from collections.abc import Iterator
from pathlib import Path

try:
    import torch
    from torch import nn
except ImportError as error:  # pragma: no cover - optional local dependency
    raise SystemExit("Install PyTorch to run policy training.") from error


INPUTS = 16


def candidate_features(record: dict, candidate: dict) -> list[float]:
    state = record["state"]
    features = record["features"]
    code = int(candidate["moveCode"])
    wall = 1.0 if code & 0x8000 else 0.0
    vertical = 1.0 if code & 0x4000 else 0.0
    location = (code & 0x3FFF) if wall else (code & 0x7F)
    width = 8 if wall else 9
    row, column = divmod(location, width)
    distances = features["distances"]
    return [
        distances[0] / 20.0,
        distances[1] / 20.0,
        state["wallsLeft"][0] / 10.0,
        state["wallsLeft"][1] / 10.0,
        float(state["turn"]),
        features["evaluation"] / 1000.0,
        features["legalMoveCount"] / 136.0,
        features["legalPawnMoveCount"] / 8.0,
        state["pawns"][0]["r"] / 8.0,
        state["pawns"][0]["c"] / 8.0,
        state["pawns"][1]["r"] / 8.0,
        state["pawns"][1]["c"] / 8.0,
        wall,
        vertical,
        row / 8.0,
        column / 8.0,
    ]


def mirror_feature_vector(values: list[float]) -> list[float]:
    mirrored = values.copy()
    for index in (9, 11, 15):
        mirrored[index] = 1.0 - mirrored[index]
    return mirrored


def iter_groups(
    paths: list[Path],
    validation_bucket: int,
    include_bucket: bool,
) -> Iterator[tuple[torch.Tensor, torch.Tensor]]:
    for path in paths:
        with path.open("r", encoding="utf-8") as source:
            for line in source:
                record = json.loads(line)
                in_bucket = int(record["index"]) % 10 == validation_bucket
                if in_bucket != include_bucket:
                    continue
                candidates = record.get("candidates", {}).get("sampled", [])
                if len(candidates) < 2:
                    continue
                inputs = torch.tensor(
                    [candidate_features(record, item) for item in candidates],
                    dtype=torch.float32,
                )
                scores = torch.tensor(
                    [float(item["score"]) for item in candidates],
                    dtype=torch.float32,
                )
                yield inputs, scores
                yield (
                    torch.tensor([mirror_feature_vector(row) for row in inputs.tolist()]),
                    scores.clone(),
                )


class Policy(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.layers = nn.Sequential(
            nn.Linear(INPUTS, 64),
            nn.ReLU(),
            nn.Linear(64, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
        )

    def forward(self, values: torch.Tensor) -> torch.Tensor:
        return self.layers(values).squeeze(-1)


def export_integer(model: Policy, destination: Path) -> None:
    tensors = []
    for layer in (model.layers[0], model.layers[2], model.layers[4]):
        for value in (layer.weight.detach().cpu(), layer.bias.detach().cpu()):
            quantized = torch.clamp(torch.round(value * 1024), -32767, 32767)
            tensors.append((tuple(value.shape), bytes(quantized.to(torch.int16).numpy())))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as output:
        output.write(b"WLPY")
        output.write(struct.pack("<II", 2, len(tensors)))
        for shape, values in tensors:
            output.write(struct.pack("<I", len(shape)))
            output.write(struct.pack(f"<{len(shape)}I", *shape))
            output.write(struct.pack("<I", len(values)))
            output.write(values)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--seed", type=int, default=20260811)
    arguments = parser.parse_args()
    torch.manual_seed(arguments.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = Policy().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-5)
    for epoch in range(arguments.epochs):
        model.train()
        total_loss = 0.0
        training_groups = 0
        for inputs, scores in iter_groups(arguments.inputs, 0, False):
            inputs, scores = inputs.to(device), scores.to(device)
            logits = model(inputs)
            centered = torch.clamp(scores - torch.max(scores), min=-1000.0)
            target = nn.functional.softmax(centered / 100.0, dim=0)
            loss = -(target * nn.functional.log_softmax(logits, dim=0)).sum()
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            total_loss += float(loss.detach())
            training_groups += 1
        if training_groups == 0:
            raise SystemExit("No training candidate groups were found in the input shards.")
        model.eval()
        correct = 0
        top_three = 0
        regret = 0.0
        validation_groups = 0
        with torch.no_grad():
            for inputs, scores in iter_groups(arguments.inputs, 0, True):
                prediction = model(inputs.to(device))
                predicted = int(torch.argmax(prediction))
                best = int(torch.argmax(scores))
                correct += predicted == best
                top_three += best in torch.topk(
                    prediction, min(3, len(prediction))
                ).indices.tolist()
                regret += float(torch.max(scores) - scores[predicted])
                validation_groups += 1
        if validation_groups == 0:
            raise SystemExit("No validation candidate groups were found in the input shards.")
        print(
            f"epoch {epoch + 1}: loss {total_loss / training_groups:.5f}, "
            f"validation top-1 {correct / validation_groups:.3%}, "
            f"top-3 {top_three / validation_groups:.3%}, "
            f"mean regret {regret / validation_groups:.2f}"
        )
    export_integer(model, arguments.output)
    print(f"wrote deterministic Q10 integer policy to {arguments.output}")


if __name__ == "__main__":
    main()
