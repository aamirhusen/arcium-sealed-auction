use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

const COMP_DEF_OFFSET_COMPARE_BIDS: u32 = comp_def_offset("compare_bids");

declare_id!("CSGgbUNEf1xzooWwapqRYKUWkf718yUHX4PsXhXhDSfA");

#[arcium_program]
pub mod sealed_auction {
    use super::*;

    // Create a new auction for an item
    pub fn create_auction(
        ctx: Context<CreateAuction>,
        item_name: String,
        duration_slots: u64,
    ) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        auction.item_name = item_name;
        auction.authority = ctx.accounts.payer.key();
        auction.highest_bidder = Pubkey::default();
        auction.bid_count = 0;
        auction.end_slot = Clock::get()?.slot + duration_slots;
        auction.finalized = false;
        Ok(())
    }

    // Register the compare_bids computation definition (once)
    pub fn init_compare_bids_comp_def(ctx: Context<InitCompareBidsCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    // Submit an encrypted bid. MPC compares it against the current highest.
    pub fn submit_bid(
        ctx: Context<SubmitBid>,
        computation_offset: u64,
        ciphertext_highest: [u8; 32],
        ciphertext_new: [u8; 32],
        pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(
            Clock::get()?.slot < ctx.accounts.auction.end_slot,
            ErrorCode::AuctionEnded
        );

        ctx.accounts.auction.bid_count += 1;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ciphertext_highest)
            .encrypted_u64(ciphertext_new)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![CompareBidsCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    // MPC returns the new highest bid (encrypted)
    #[arcium_callback(encrypted_ix = "compare_bids")]
    pub fn compare_bids_callback(
        ctx: Context<CompareBidsCallback>,
        output: SignedComputationOutputs<CompareBidsOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(CompareBidsOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        emit!(BidProcessedEvent {
            highest_bid_ciphertext: o.ciphertexts[0],
            nonce: o.nonce.to_le_bytes(),
        });
        Ok(())
    }
}

#[account]
pub struct Auction {
    pub item_name: String,
    pub authority: Pubkey,
    pub highest_bidder: Pubkey,
    pub bid_count: u64,
    pub end_slot: u64,
    pub finalized: bool,
}

#[derive(Accounts)]
pub struct CreateAuction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + 4 + 100 + 32 + 32 + 8 + 8 + 1,
        seeds = [b"auction", payer.key().as_ref()],
        bump,
    )]
    pub auction: Account<'info, Auction>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("compare_bids", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SubmitBid<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"auction", auction_authority.key().as_ref()],
        bump,
    )]
    pub auction: Account<'info, Auction>,
    /// CHECK: auction creator's pubkey used as seed
    pub auction_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: checked by arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: checked by arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_COMPARE_BIDS))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("compare_bids")]
#[derive(Accounts)]
pub struct CompareBidsCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_COMPARE_BIDS))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: instructions sysvar
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[init_computation_definition_accounts("compare_bids", payer)]
#[derive(Accounts)]
pub struct InitCompareBidsCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: not yet initialized
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: checked by arcium program
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: LUT program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct BidProcessedEvent {
    pub highest_bid_ciphertext: [u8; 32],
    pub nonce: [u8; 16],
}

#[error_code]
pub enum ErrorCode {
    #[msg("Auction has ended")]
    AuctionEnded,
    #[msg("The computation was aborted")]
    AbortedComputation,
}
