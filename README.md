# Watch Tower Config
> ⚠️ This is a temp branch, and it will be moved soon to a private repository

Private repository with the configuration for https://github.com/cowprotocol/watch-tower

## Filter Policy
The filter policy allow to filter the Programmatic Orders being indexed by Watch Tower.

It allows to filter by:
- `owner`: The owner contract of the order
- `handler`: The handler contract

For each filter, it allows to specify the action to take:
* `SKIP`: Will skip the order. Next block, we will decide again based on the configuration by the time is processed, if it's still `SKIP` will keep not processing the order.
* `DROP`:  Will skip the order for this run and any future blocks.

## Example of configuration
One example of the configuration is the following:
```json
{
  "owners": {
    "0x0000000000000000000000000000000000000001": "DROP",
    "0x0000000000000000000000000000000000000002": "DROP",
    "0x0000000000000000000000000000000000000003": "SKIP",
  },
  "handlers": {
    "0x0000000000000000000000000000000000000004": "DROP"
  }
}
```

In this example:
- Any order placed by the **owner contract** `0x1` or `0x2` will be dropped. 
  - Future executions won't check the order with that specific owner.
- Any order placed by the **owner contract** `0x3` will be skipped. 
   - Watch tower will still keep track of it.
   - If in the future, this rule is removed, the order will resume being processed again.
   - This allows to disable temporarily orders checks. 
   - For example, if some bug in the Watch Tower is discovered, and the errors are creating some noise. It allows you to disable the order temporarily, and re-enable it later once the fix has been applied.
- Any order whose **handler contract** is `0x4` will be dropped.
  - Future executions won't check on the order with that specific handler.
  - This allows to disable specific conditional orders (e.g. To specify things like "Do not index this TWAP orders implementation"). 