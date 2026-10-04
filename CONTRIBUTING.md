# Contributing

Thanks for helping improve the `amdahl` CLI.

## Before you start

For anything larger than a small fix, please open an issue first so we can
agree on the approach. For security issues, follow [SECURITY.md](SECURITY.md)
instead.

## Making a change

1. Fork the repository and create a branch off `main`.
2. `pnpm install`, then make your change. Add or update tests in `__tests__/`.
3. Make sure these all pass:

   ```sh
   pnpm type-check
   pnpm test
   pnpm build
   pnpm smoke:pack
   ```

4. Open a pull request. CI runs the same checks on Node 20 and 24, and a
   maintainer reviews every PR.

## Compatibility

The `--json` output shapes, the exit codes and the command-line flags are a
stable interface that scripts depend on. Do not change their meaning. Add new
fields or flags instead, and call out any change to them in your PR.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
