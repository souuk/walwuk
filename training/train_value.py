"""Train an optional compact integer value model from verifier labels."""

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
    raise SystemExit("Install PyTorch to run value training.") from error


def features(record: dict) -> list[float]:
    state = record["state"]
    item = record["features"]
    pawn_move_counts = item.get("pawnMoveCounts")
    if pawn_move_counts is None:
        # Version-two shards recorded only the side-to-move count. Retain
        # compatibility without pretending that it measured both players.
        pawn_move_counts = [item["legalPawnMoveCount"], item["legalPawnMoveCount"]]
    turn = int(state["turn"])
    return [
        item["distances"][0] / 20.0,
        item["distances"][1] / 20.0,
        state["wallsLeft"][0] / 10.0,
        state["wallsLeft"][1] / 10.0,
        float(state["turn"]),
        pawn_move_counts[turn] / 8.0,
        pawn_move_counts[1 - turn] / 8.0,
        state["pawns"][0]["r"] / 8.0,
        state["pawns"][0]["c"] / 8.0,
        state["pawns"][1]["r"] / 8.0,
        state["pawns"][1]["c"] / 8.0,
        (state["wallsLeft"][0] + state["wallsLeft"][1]) / 20.0,
    ]


class Value(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.layers = nn.Sequential(
            nn.Linear(12, 256),
            nn.ReLU(),
            nn.Linear(256, 32),
            nn.ReLU(),
            nn.Linear(32, 1),
        )

    def forward(self, values: torch.Tensor) -> torch.Tensor:
        return self.layers(values).squeeze(-1)


def mirror_feature_vector(values: list[float]) -> list[float]:
    mirrored = values.copy()
    for index in (8, 10):
        mirrored[index] = 1.0 - mirrored[index]
    return mirrored


def iter_examples(
    paths: list[Path],
    validation_bucket: int,
    include_bucket: bool,
) -> Iterator[tuple[list[float], float]]:
    for path in paths:
        with path.open("r", encoding="utf-8") as source:
            for line in source:
                record = json.loads(line)
                in_bucket = int(record["index"]) % 10 == validation_bucket
                if in_bucket != include_bucket:
                    continue
                vector = features(record)
                label = max(-1.0, min(1.0, record["label"]["score"] / 1000.0))
                yield vector, label
                yield mirror_feature_vector(vector), label


def iter_batches(
    paths: list[Path],
    validation_bucket: int,
    include_bucket: bool,
    batch_size: int,
) -> Iterator[tuple[torch.Tensor, torch.Tensor]]:
    inputs: list[list[float]] = []
    labels: list[float] = []
    for vector, label in iter_examples(paths, validation_bucket, include_bucket):
        inputs.append(vector)
        labels.append(label)
        if len(inputs) == batch_size:
            yield torch.tensor(inputs, dtype=torch.float32), torch.tensor(
                labels, dtype=torch.float32
            )
            inputs, labels = [], []
    if inputs:
        yield torch.tensor(inputs, dtype=torch.float32), torch.tensor(
            labels, dtype=torch.float32
        )


def export_integer(model: Value, destination: Path) -> None:
    tensors = []
    for layer in (model.layers[0], model.layers[2], model.layers[4]):
        for value in (layer.weight.detach().cpu(), layer.bias.detach().cpu()):
            values = bytes(torch.clamp(torch.round(value * 1024), -32767, 32767).to(torch.int16).numpy())
            tensors.append((tuple(value.shape), values))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as output:
        output.write(b"WLVL")
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
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=1024)
    parser.add_argument("--seed", type=int, default=20260811)
    arguments = parser.parse_args()
    if arguments.batch_size < 1:
        raise SystemExit("--batch-size must be positive")
    torch.manual_seed(arguments.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = Value().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-5)
    for epoch in range(arguments.epochs):
        model.train()
        total_train_loss = 0.0
        train_examples = 0
        for train_x, train_y in iter_batches(
            arguments.inputs, 0, False, arguments.batch_size
        ):
            train_x, train_y = train_x.to(device), train_y.to(device)
            prediction = model(train_x)
            loss = nn.functional.huber_loss(prediction, train_y)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            total_train_loss += float(loss.detach()) * len(train_y)
            train_examples += len(train_y)
        if train_examples == 0:
            raise SystemExit("No training positions were found in the input shards.")
        model.eval()
        validation_loss = 0.0
        absolute_error = 0.0
        validation_examples = 0
        with torch.no_grad():
            for test_x, test_y in iter_batches(
                arguments.inputs, 0, True, arguments.batch_size
            ):
                test_x, test_y = test_x.to(device), test_y.to(device)
                test_prediction = model(test_x)
                validation_loss += float(nn.functional.huber_loss(
                    test_prediction, test_y, reduction="sum"
                ))
                absolute_error += float(torch.sum(torch.abs(test_prediction - test_y)))
                validation_examples += len(test_y)
        if validation_examples == 0:
            raise SystemExit("No validation positions were found in the input shards.")
        print(
            f"epoch {epoch + 1}: train {total_train_loss / train_examples:.6f}, "
            f"validation {validation_loss / validation_examples:.6f}, "
            f"mae {absolute_error / validation_examples:.6f}"
        )
    export_integer(model, arguments.output)
    print(f"wrote deterministic Q10 integer value model to {arguments.output}")


if __name__ == "__main__":
    main()
