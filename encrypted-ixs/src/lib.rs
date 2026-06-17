use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    pub struct BidComparison {
        current_highest: u64,
        new_bid: u64,
    }

    // Returns the higher of two bids without revealing the lower one.
    // Used to maintain a running "highest bid" as bids come in.
    #[instruction]
    pub fn compare_bids(input_ctxt: Enc<Shared, BidComparison>) -> Enc<Shared, u64> {
        let input = input_ctxt.to_arcis();
        let highest = if input.new_bid > input.current_highest {
            input.new_bid
        } else {
            input.current_highest
        };
        input_ctxt.owner.from_arcis(highest)
    }
}
