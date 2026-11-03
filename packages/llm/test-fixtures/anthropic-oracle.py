"""Actual cloud classifier with invented inputs and an in-process HTTPX transport only."""

import contextlib
import io
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

assert os.environ.get("CASHU_TESTING") == "1"
home = Path(os.environ["HOME"]).resolve()
assert home.name.startswith("cashu-llm-oracle-")
for key in (
    "CASHU_DATA_DIR",
    "CASHU_WORKSPACES_DIR",
    "CASHU_LEGACY_DATA_DIR",
    "CASHU_LAUNCH_AGENTS_DIR",
):
    assert Path(os.environ[key]).resolve().is_relative_to(home)

from cashu.core.paths import data_dir

assert data_dir() == Path(os.environ["CASHU_DATA_DIR"]).resolve()

import httpx

from cashu.modules.budget.categorize import llm

request = json.load(sys.stdin)
requests = []
timeouts = []
responses = request["responses"]


def handle(call):
    index = len(requests)
    requests.append(
        {
            "url": str(call.url),
            "headers": {
                name: call.headers[name]
                for name in ("x-api-key", "anthropic-version", "content-type")
            },
            "body": call.content.decode("utf-8"),
        }
    )
    response = responses[min(index, len(responses) - 1)]
    if response.get("raises"):
        raise httpx.ConnectError("synthetic transport failure", request=call)
    if "text" in response:
        return httpx.Response(response.get("status", 200), text=response["text"])
    return httpx.Response(
        response.get("status", 200),
        json=response.get("json"),
        headers=response.get("headers"),
    )


real_client = httpx.Client


def client(**options):
    timeouts.append(options["timeout"])
    options["transport"] = httpx.MockTransport(handle)
    return real_client(**options)


stderr = io.StringIO()
with patch.object(httpx, "Client", client), contextlib.redirect_stderr(stderr):
    answers = llm.classify_merchants(
        request["merchants"],
        request["keys"],
        api_key="synthetic-key",
        model="synthetic-model",
    )
json.dump(
    {
        "requests": requests,
        "timeouts": timeouts,
        "answers": answers,
        # No raw error text crosses the fixture boundary.
        "failed_batches": stderr.getvalue().count("failed, skipping:"),
    },
    sys.stdout,
    ensure_ascii=False,
)
