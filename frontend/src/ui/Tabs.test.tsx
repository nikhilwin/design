import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Tab, TabList, TabPanel, Tabs } from './Tabs'

function Example() {
  return (
    <Tabs defaultValue="login">
      <TabList label="Account">
        <Tab value="login">Log in</Tab>
        <Tab value="signup">Sign up</Tab>
      </TabList>
      <TabPanel value="login">Login form</TabPanel>
      <TabPanel value="signup">Signup form</TabPanel>
    </Tabs>
  )
}

describe('Tabs', () => {
  it('shows the selected panel and wires aria attributes', () => {
    render(<Example />)
    const tab = screen.getByRole('tab', { name: 'Log in' })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tab.id)
    expect(screen.queryByText('Signup form')).not.toBeInTheDocument()
  })

  it('moves selection with arrow keys (roving tabindex)', async () => {
    render(<Example />)
    screen.getByRole('tab', { name: 'Log in' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Sign up' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Log in' })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByText('Signup form')).toBeInTheDocument()
    await userEvent.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Log in' })).toHaveAttribute('aria-selected', 'true')
  })
})
