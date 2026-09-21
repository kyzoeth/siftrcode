#!/usr/bin/env python3
"""
Diagnostic runner to verify that every final holdout task strictly adheres to:
1. Base commit: MUST FAIL (exitCode != 0)
2. Solution: MUST PASS (exitCode == 0)
"""

import subprocess, tempfile, shutil, os, sys

def test_contract(repo, base_commit, verifier_code, verifier_ext, apply_sol_fn):
    tmp = tempfile.mkdtemp()
    source_dir = f"benchmarks/{repo}-repo" if repo != "siftrcode" else "."
    try:
        subprocess.run(["git", "-C", source_dir, "worktree", "add", "--detach", tmp, base_commit],
                       check=True, capture_output=True)

        if repo in ["express", "commander", "siftrcode"]:
            nm = "node_modules" if repo == "siftrcode" else f"benchmarks/{repo}-repo/node_modules"
            if os.path.exists(nm):
                try: os.symlink(os.path.abspath(nm), os.path.join(tmp, "node_modules"))
                except: pass
        if repo == "fastapi":
            venv = "benchmarks/fastapi-repo/venv"
            if os.path.exists(venv):
                try: os.symlink(os.path.abspath(venv), os.path.join(tmp, "venv"))
                except: pass
        if repo == "siftrcode":
            dist = "dist"
            if os.path.exists(dist):
                shutil.copytree(dist, os.path.join(tmp, "dist"))

        v_path = os.path.join(tmp, f"verify.{verifier_ext}")
        with open(v_path, "w") as f:
            f.write(verifier_code)

        cmd = ["node", f"verify.{verifier_ext}"] if verifier_ext in ["js", "mjs"] else ["./venv/bin/python", f"verify.{verifier_ext}"]

        # 1. Base run
        res_base = subprocess.run(cmd, cwd=tmp, capture_output=True, text=True)
        base_failed = res_base.returncode != 0

        # 2. Apply solution
        apply_sol_fn(tmp)

        # 3. Sol run
        res_sol = subprocess.run(cmd, cwd=tmp, capture_output=True, text=True)
        sol_passed = res_sol.returncode == 0

        return {
            "base_exit": res_base.returncode,
            "base_failed": base_failed,
            "sol_exit": res_sol.returncode,
            "sol_passed": sol_passed,
            "sol_err": res_sol.stderr[:100] if not sol_passed else ""
        }
    finally:
        subprocess.run(["git", "-C", source_dir, "worktree", "remove", "-f", tmp], capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)

print("Contract tester ready.")
